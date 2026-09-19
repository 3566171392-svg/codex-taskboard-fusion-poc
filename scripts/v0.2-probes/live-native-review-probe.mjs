/**
 * Live probe for Codex native review, on this machine's actual build.
 *
 * Answers, with real app-server traffic only:
 *   1. Does `thread/start` default to a paginated or legacy history mode?
 *   2. Does `review/start` with `delivery: "detached"` succeed on that thread?
 *   3. What does the detached review lifecycle actually emit
 *      (turn/started, enteredReviewMode, exitedReviewMode, turn/completed)?
 *   4. What is the exact shape and content of the exitedReviewMode payload?
 *   5. Does the officially recommended replacement (separate thread +
 *      `delivery: "inline"`) work, and does it satisfy the "independent review
 *      thread" requirement?
 *
 * One review target is real (`uncommittedChanges` in FUSION_POC_CWD); the
 * fallback probe uses a `custom` target pointing at a path that does not exist,
 * so it cannot review real code while still settling the lifecycle question.
 *
 * Writes no files and mutates no repository state.
 */
import { spawn } from "node:child_process";

const cwd = process.env.FUSION_POC_CWD;
const model = process.env.FUSION_POC_MODEL ?? "<your-model>";
const codexHome = process.env.CODEX_HOME;
if (!cwd) {
  console.error("Set FUSION_POC_CWD first.");
  process.exit(2);
}

const child = spawn("codex", ["app-server", "--stdio"], {
  cwd,
  env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });

const notes = [];
const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && message.id !== null) {
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); }
    } else {
      notes.push(message);
    }
  }
});

const request = (method, params) => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
};
const notify = (method, params = {}) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTurnCompleted(turnId, timeoutMs = 600_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const hit = notes.find((n) => n.method === "turn/completed" && n.params?.turn?.id === turnId);
    if (hit) return hit.params.turn;
    await sleep(250);
  }
  throw new Error(`timeout waiting for turn/completed of ${turnId}`);
}

const reviewLifecycleFor = (turnId) => notes
  .filter((n) => n.method === "item/started" || n.method === "item/completed")
  .filter((n) => n.params?.turnId === turnId || n.params?.turn?.id === turnId)
  .map((n) => ({
    method: n.method,
    type: n.params?.item?.type,
    review: typeof n.params?.item?.review === "string" ? n.params.item.review : undefined,
  }))
  .filter((n) => n.type === "enteredReviewMode" || n.type === "exitedReviewMode");

const report = { cwd, model, codexHome: codexHome ?? null };

try {
  const init = await request("initialize", {
    clientInfo: { name: "fusion-v2-native-review-probe", title: "v2 native review probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  report.initialize = init.result ?? init.error;
  notify("initialized", {});

  // ---- Phase 1: default thread, detached review -------------------------
  const defaultThread = await request("thread/start", {
    cwd, model, modelProvider: "custom", sandbox: "workspace-write",
  });
  const executorThreadId = defaultThread.result?.thread?.id;
  report.phase1 = {
    executorThreadId,
    historyMode: defaultThread.result?.thread?.historyMode ?? null,
  };

  const detached = await request("review/start", {
    threadId: executorThreadId,
    delivery: "detached",
    target: { type: "uncommittedChanges" },
  });
  report.phase1.detached = {
    error: detached.error ?? null,
    reviewThreadId: detached.result?.reviewThreadId ?? null,
    reviewTurnId: detached.result?.turn?.id ?? null,
  };

  // ---- Phase 2: legacy thread, detached review (real lifecycle) ---------
  const legacyThread = await request("thread/start", {
    cwd, model, modelProvider: "custom", sandbox: "workspace-write", historyMode: "legacy",
  });
  const legacyExecutorThreadId = legacyThread.result?.thread?.id;
  const legacyDetached = await request("review/start", {
    threadId: legacyExecutorThreadId,
    delivery: "detached",
    target: { type: "uncommittedChanges" },
  });
  report.phase2 = {
    executorThreadId: legacyExecutorThreadId,
    historyMode: legacyThread.result?.thread?.historyMode ?? null,
    reviewThreadId: legacyDetached.result?.reviewThreadId ?? null,
    reviewTurnId: legacyDetached.result?.turn?.id ?? null,
    error: legacyDetached.error ?? null,
    independentThread:
      Boolean(legacyDetached.result?.reviewThreadId)
      && legacyDetached.result.reviewThreadId !== legacyExecutorThreadId,
  };
  if (legacyDetached.result?.turn?.id) {
    const turn = await waitForTurnCompleted(legacyDetached.result.turn.id);
    report.phase2.turnStatus = turn.status;
    report.phase2.turnError = turn.error ?? null;
    report.phase2.lifecycle = reviewLifecycleFor(legacyDetached.result.turn.id);
    report.phase2.agentMessages = (turn.items ?? [])
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text);
  }

  // ---- Phase 3: official replacement (separate thread + inline review) --
  const separate = await request("thread/start", {
    cwd, model, modelProvider: "custom", sandbox: "read-only",
  });
  report.phase3 = { separateReviewThreadId: separate.result?.thread?.id ?? null };
  const inline = await request("review/start", {
    threadId: report.phase3.separateReviewThreadId,
    delivery: "inline",
    target: { type: "custom", instructions: "Confirm you can read this workspace. Reply with a single sentence." },
  });
  report.phase3.inline = {
    error: inline.error ?? null,
    reviewThreadId: inline.result?.reviewThreadId ?? null,
    reviewTurnId: inline.result?.turn?.id ?? null,
    reviewThreadEqualsInput:
      inline.result?.reviewThreadId === report.phase3.separateReviewThreadId,
  };
  if (inline.result?.turn?.id) {
    const turn = await waitForTurnCompleted(inline.result.turn.id);
    report.phase3.turnStatus = turn.status;
    report.phase3.lifecycle = reviewLifecycleFor(inline.result.turn.id);
  }

  await sleep(500);
  report.deprecationNotices = notes
    .filter((n) => n.method === "deprecationNotice")
    .map((n) => n.params);
  report.notificationMethods = [...new Set(notes.map((n) => n.method))].sort();
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = stderr.split("\n").slice(-4).join("\n");
  child.kill();
  await sleep(300);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
