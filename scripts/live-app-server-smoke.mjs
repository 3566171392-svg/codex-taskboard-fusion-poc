/**
 * Live smoke test: the four App Server primitives this POC depends on.
 *
 *   initialize -> thread/start -> turn/start -> turn/completed
 *
 * Scope is deliberately limited to that. The previous revision also drove
 * `review/start` with `delivery: "detached"`, which Codex now refuses on
 * paginated threads and marks deprecated, so the smoke could never complete.
 * Review is verified separately by the structured-reviewer scripts.
 *
 * The script also fingerprints the workspace before and after the turn so
 * "no unexpected modification" is a checked fact rather than an assumption.
 * The turn runs with a read-only sandbox, so a write would also be a failure.
 *
 * Opt-in: it consumes a real model call. Uses whatever CODEX_HOME is set.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const cwd = process.env.FUSION_POC_CWD ?? process.cwd();
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 600_000);

if (!model) {
  console.error("Set FUSION_POC_MODEL before running the live smoke test.");
  process.exit(2);
}
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
  console.error(`FUSION_POC_CWD is not a directory: ${cwd}`);
  process.exit(2);
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".live"]);

/** Deterministic content fingerprint of a workspace tree. */
function fingerprint(root) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(full);
      entries.push(`${rel}\t${bytes.length}\t${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
    }
  };
  walk(root, "");
  return entries;
}

const before = fingerprint(cwd);
const server = new AppServerStdio({ cwd, timeoutMs: 120_000 });
const report = { cwd, model, modelProvider, codexHome: process.env.CODEX_HOME ?? null };

try {
  await server.start();
  report.initialize = "ok";

  const thread = await server.startThread({
    cwd, model, modelProvider, sandbox: "read-only",
  });
  const threadId = thread?.thread?.id ?? null;
  if (!threadId) throw new Error("thread/start returned no thread id");
  report.thread = {
    executorThreadId: threadId,
    historyMode: thread.thread?.historyMode ?? null,
    sandbox: thread.sandbox?.type ?? null,
  };

  const started = await server.startTurn({
    threadId,
    message: "Read this repository and reply with exactly one line: FUSION_EXECUTOR_READY",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  const turnId = started?.turn?.id ?? null;
  if (!turnId) throw new Error("turn/start returned no turn id");
  report.executorTurnId = turnId;

  const completed = await server.waitForTurn({ threadId, turnId, timeoutMs });
  report.turn = {
    status: completed.status,
    error: completed.error,
    itemTypes: completed.items.map((item) => item.type),
    agentMessages: completed.items.filter((item) => item.type === "agentMessage").map((item) => item.text),
  };
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = (server.lastStderr ?? "").split("\n").slice(-3).join("\n");
  await server.stop();
}

const after = fingerprint(cwd);
report.workspace = {
  unchanged: before.length === after.length && before.every((line, i) => line === after[i]),
  files: before.length,
  added: after.filter((line) => !before.includes(line)).map((line) => line.split("\t")[0]),
  removed: before.filter((line) => !after.includes(line)).map((line) => line.split("\t")[0]),
};

console.log(JSON.stringify(report, null, 2));
if (report.error || report.turn?.status !== "completed" || report.workspace.unchanged !== true) {
  process.exit(1);
}
