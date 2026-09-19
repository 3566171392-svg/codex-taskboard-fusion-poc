/**
 * Focused live probe of the native Codex review lifecycle on this machine.
 *
 * Settles two questions that the v0.2 gate depends on:
 *
 *  A. Detached review: which notifications actually arrive, on which
 *     thread/turn, and what exactly does `exitedReviewMode.review` contain?
 *  B. Inline review on a separate thread (the officially recommended
 *     replacement): same questions, plus whether the client can see the
 *     structured ReviewOutputEvent fields at all.
 *
 * Every notification is recorded with its real threadId/turnId so the grouping
 * is evidence, not inference. Read-only with respect to the repository.
 */
import { spawn } from "node:child_process";

const cwd = process.env.FUSION_POC_CWD;
const model = process.env.FUSION_POC_MODEL ?? "<your-model>";
if (!cwd) {
  console.error("Set FUSION_POC_CWD first.");
  process.exit(2);
}

const child = spawn("codex", ["app-server", "--stdio"], {
  cwd,
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-3_000); });

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

async function waitForTurnCompleted(turnId, timeoutMs = 900_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const hit = notes.find((n) => n.method === "turn/completed" && n.params?.turn?.id === turnId);
    if (hit) return hit.params.turn;
    await sleep(250);
  }
  throw new Error(`timeout waiting for turn/completed ${turnId}`);
}

/** Every notification attributable to a turn, in arrival order. */
function timelineFor(turnId) {
  return notes
    .filter((n) => n.params?.turnId === turnId || n.params?.turn?.id === turnId)
    .map((n) => ({
      method: n.method,
      threadId: n.params?.threadId ?? null,
      itemType: n.params?.item?.type ?? null,
      reviewText:
        typeof n.params?.item?.review === "string" ? n.params.item.review : undefined,
    }));
}

const report = { cwd, model, phases: {} };
try {
  const init = await request("initialize", {
    clientInfo: { name: "fusion-v2-lifecycle-probe", title: "v2 lifecycle probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  report.initialize = init.result ?? init.error;
  notify("initialized", {});

  // ---- A. detached review on a legacy thread, real uncommitted changes ----
  const legacy = await request("thread/start", {
    cwd, model, modelProvider: "custom", sandbox: "workspace-write", historyMode: "legacy",
  });
  const executorThreadId = legacy.result?.thread?.id;
  const detached = await request("review/start", {
    threadId: executorThreadId,
    delivery: "detached",
    target: { type: "uncommittedChanges" },
  });
  const a = {
    executorThreadId,
    historyMode: legacy.result?.thread?.historyMode ?? null,
    error: detached.error ?? null,
    reviewThreadId: detached.result?.reviewThreadId ?? null,
    reviewTurnId: detached.result?.turn?.id ?? null,
    reviewThreadIsIndependent: Boolean(detached.result?.reviewThreadId)
      && detached.result.reviewThreadId !== executorThreadId,
  };
  if (detached.result?.turn?.id) {
    const turn = await waitForTurnCompleted(detached.result.turn.id);
    a.turnStatus = turn.status;
    a.timeline = timelineFor(detached.result.turn.id);
    a.reviewItems = a.timeline.filter((t) => t.itemType === "enteredReviewMode" || t.itemType === "exitedReviewMode");
    a.agentMessages = (turn.items ?? []).filter((i) => i.type === "agentMessage").map((i) => i.text);
  }
  report.phases.detachedReview = a;

  // ---- B. inline review on a separate thread (recommended replacement) ----
  const separate = await request("thread/start", {
    cwd, model, modelProvider: "custom", sandbox: "read-only",
  });
  const reviewThreadId = separate.result?.thread?.id;
  const inline = await request("review/start", {
    threadId: reviewThreadId,
    delivery: "inline",
    target: {
      type: "custom",
      instructions:
        "Review the function divide in project/src/math.js for correctness. "
        + "Report every real defect you can substantiate from the file. Be concise.",
    },
  });
  const b = {
    executorThreadId,
    separateReviewThreadId: reviewThreadId,
    error: inline.error ?? null,
    reviewThreadId: inline.result?.reviewThreadId ?? null,
    reviewTurnId: inline.result?.turn?.id ?? null,
    independentFromExecutor:
      Boolean(inline.result?.reviewThreadId) && inline.result.reviewThreadId !== executorThreadId,
  };
  if (inline.result?.turn?.id) {
    const turn = await waitForTurnCompleted(inline.result.turn.id);
    b.turnStatus = turn.status;
    b.timeline = timelineFor(inline.result.turn.id);
    b.reviewItems = b.timeline.filter((t) => t.itemType === "enteredReviewMode" || t.itemType === "exitedReviewMode");
    b.agentMessages = (turn.items ?? []).filter((i) => i.type === "agentMessage").map((i) => i.text);
    b.renderedFindingsMarker = b.reviewItems.some((t) => typeof t.reviewText === "string" && /Review comment|Full review comments:/.test(t.reviewText));
  }
  report.phases.inlineReviewOnSeparateThread = b;

  await sleep(500);
  report.deprecationNotices = notes.filter((n) => n.method === "deprecationNotice").map((n) => n.params);
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = stderr.split("\n").slice(-3).join("\n");
  child.kill();
  await sleep(300);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
