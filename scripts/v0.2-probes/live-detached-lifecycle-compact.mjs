/**
 * Focused probe: does detached review emit enteredReviewMode / exitedReviewMode?
 *
 * Records every review-mode item regardless of which thread or turn carries it,
 * plus the turn/started + turn/completed pairs per thread. Prints a compact
 * summary only (no streaming deltas).
 */
import { spawn } from "node:child_process";

const cwd = process.env.FUSION_POC_CWD;
const model = process.env.FUSION_POC_MODEL ?? "<your-model>";
if (!cwd) { console.error("Set FUSION_POC_CWD."); process.exit(2); }

const child = spawn("codex", ["app-server", "--stdio"], {
  cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => { stderr = `${stderr}${c}`.slice(-2_000); });

const reviewItems = [];
const turnStarts = [];
const turnCompletes = [];
const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf("\n");
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf("\n");
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.id !== null) {
      const w = pending.get(m.id); if (w) { pending.delete(m.id); w(m); }
      continue;
    }
    const item = m.params?.item;
    if (item && (item.type === "enteredReviewMode" || item.type === "exitedReviewMode")) {
      reviewItems.push({
        method: m.method,
        threadId: m.params.threadId,
        turnId: m.params.turnId,
        type: item.type,
        reviewLength: typeof item.review === "string" ? item.review.length : null,
        reviewHead: typeof item.review === "string" ? item.review.slice(0, 80).replace(/\s+/g, " ") : null,
      });
    } else if (m.method === "turn/started") {
      turnStarts.push({ threadId: m.params?.threadId, turnId: m.params?.turn?.id });
    } else if (m.method === "turn/completed") {
      turnCompletes.push({
        threadId: m.params?.threadId,
        turnId: m.params?.turn?.id,
        status: m.params?.turn?.status,
        agentMessages: (m.params?.turn?.items ?? []).filter((x) => x.type === "agentMessage").length,
      });
    }
  }
});

const request = (method, params) => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
};
const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { cwd, model };
try {
  const init = await request("initialize", {
    clientInfo: { name: "v2-detached-compact", title: "v2 detached compact", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  report.initialize = init.result?.userAgent ?? init.error;
  notify("initialized", {});

  const legacy = await request("thread/start", {
    cwd, model, modelProvider: "custom", sandbox: "workspace-write", historyMode: "legacy",
  });
  const executorThreadId = legacy.result?.thread?.id;
  report.executorThreadId = executorThreadId;

  const started = await request("review/start", {
    threadId: executorThreadId,
    delivery: "detached",
    target: { type: "uncommittedChanges" },
  });
  report.reviewStartError = started.error ?? null;
  report.reviewThreadId = started.result?.reviewThreadId ?? null;
  report.reviewTurnId = started.result?.turn?.id ?? null;
  report.reviewThreadIsIndependent =
    Boolean(report.reviewThreadId) && report.reviewThreadId !== executorThreadId;

  if (report.reviewTurnId) {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      if (turnCompletes.some((t) => t.turnId === report.reviewTurnId)) break;
      await sleep(400);
    }
  }
  await sleep(1_000);
  report.turnStarts = turnStarts;
  report.turnCompletes = turnCompletes;
  report.reviewModeItems = reviewItems;
  report.warning =
    reviewItems.length === 0
      ? "detached review produced NO enteredReviewMode/exitedReviewMode items"
      : null;
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = stderr.split("\n").slice(-3).join("\n");
  child.kill();
  await sleep(300);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
