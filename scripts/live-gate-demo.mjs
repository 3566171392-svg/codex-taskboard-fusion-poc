/**
 * Real end-to-end demo of the Codex-native Review Gate MVP.
 *
 * Everything here is real: a real `codex app-server --stdio`, real threads, real
 * model turns, Codex's native `review/start`, and a real workspace on disk with
 * a real failing test.
 *
 *   Executor A (workspace-write) implements
 *     -> machine evidence: real `node --test`, git state, workspace fingerprint
 *   Reviewer B (fresh, read-only) runs native `review/start inline`  -> FAIL
 *     -> task todo -> in_progress
 *   Executor A repairs (the SAME thread; no new executor is created)
 *   Reviewer C (fresh, read-only) runs native `review/start inline`  -> PASS
 *     -> in_review + READY_FOR_ACCEPTANCE (never automatic `done`)
 *
 * Taskboard is an in-memory board: the user's dashi instance is not started.
 *
 * Env: FUSION_POC_WORKSPACE, FUSION_POC_MODEL, FUSION_POC_MODEL_PROVIDER.
 */
import fs from "node:fs";
import path from "node:path";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";
import { executeNativeReviewGate } from "../src/core/review-gate.mjs";
import { collectEvidence, fingerprintWorkspace } from "../src/core/evidence.mjs";

const workspacePath = process.env.FUSION_POC_WORKSPACE;
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 900_000);

if (!workspacePath || !model) {
  console.error("Set FUSION_POC_WORKSPACE and FUSION_POC_MODEL.");
  process.exit(2);
}

class MemoryBoard {
  constructor() {
    this.task = { id: "GATE-1", version: 1, status: "todo", title: "Fix the crossSign orientation defect" };
    this.comments = [];
  }
  async getTask() { return structuredClone(this.task); }
  async moveTask(id, status, version) {
    if (version !== this.task.version) throw new Error(`version conflict: ${version} != ${this.task.version}`);
    this.task.status = status;
    this.task.version += 1;
    return structuredClone(this.task);
  }
  async addComment(_id, comment) { this.comments.push({ body: comment.body, threadId: comment.binding?.threadId ?? null }); }
}

const requiredChecks = [
  { command: process.execPath, args: ["--test"], timeoutMs: 120_000 },
];

const acceptanceCriteria = [
  "The existing test suite must pass with no test weakened, skipped, deleted, or added.",
  "crossSign must match the convention documented in its own docstring.",
  "Only the defective source file should need to change.",
];

const appServer = new AppServerStdio({ cwd: workspacePath, timeoutMs: 120_000 });
const report = {
  workspacePath,
  model,
  modelProvider,
  requiredChecks: requiredChecks.map((c) => [c.command, ...(c.args ?? [])].join(" ")),
  events: [],
};

try {
  await appServer.start();

  // ---- Executor thread A (workspace-write) --------------------------------
  const executorThread = await appServer.startThread({
    cwd: workspacePath, model, modelProvider, sandbox: "workspace-write",
  });
  const executorThreadId = executorThread?.thread?.id ?? null;
  if (!executorThreadId) throw new Error("executor thread/start returned no thread id");
  report.executorThread = {
    threadId: executorThreadId,
    sandbox: executorThread?.sandbox?.type ?? null,
    model: executorThread?.model ?? null,
  };

  const executorBinding = {
    threadId: executorThreadId,
    codexProjectId: "gate-demo",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  };

  // Machine evidence is collected by the Gate's own collector, not by the model.
  let baseline = fingerprintWorkspace(workspacePath);

  const executor = {
    binding: executorBinding,
    async collectHandoff({ attempt }) {
      const evidence = await collectEvidence({
        workspacePath, requiredChecks, fingerprintBefore: baseline, timeoutMs,
      });
      report.events.push({
        event: "evidence",
        attempt,
        allChecksPassed: evidence.allChecksPassed,
        checks: evidence.checks.map((c) => ({ command: c.command, passed: c.passed, exitCode: c.exitCode })),
        gitDirty: evidence.git?.dirty ?? null,
        changedFiles: evidence.git?.changedFiles ?? null,
        fingerprintCount: evidence.fingerprint.count,
      });
      return evidence;
    },
    async repair({ reviewerFindings, attempt }) {
      baseline = fingerprintWorkspace(workspacePath);
      const instruction = [
        "You are the executor for this Node.js project.",
        `Workspace: ${workspacePath}`,
        "",
        "An independent reviewer rejected the previous attempt. Its review:",
        "-----",
        String(reviewerFindings ?? "").slice(0, 4_000),
        "-----",
        "",
        "Fix the real defect so the existing test suite passes.",
        "Do not weaken, skip, delete, or add tests. Do not add files.",
        "Run the test suite yourself and report the result.",
      ].join("\n");
      const started = await appServer.startTurn({
        threadId: executorThreadId,
        message: instruction,
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
      });
      const completed = await appServer.waitForTurn({
        threadId: executorThreadId, turnId: started.turn?.id ?? null, timeoutMs,
      });
      const text = completed.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
      report.events.push({
        event: "executor.repair",
        attempt,
        threadId: executorThreadId,
        turnId: completed.turnId,
        status: completed.status,
        agentTextHead: text.slice(0, 1_200),
      });
    },
  };

  const board = new MemoryBoard();
  const result = await executeNativeReviewGate({
    taskId: board.task.id,
    task: await board.getTask(),
    executor,
    appServer,
    taskboard: board,
    model,
    modelProvider,
    maxAttempts: 3,
    reviewTimeoutMs: timeoutMs,
    acceptanceCriteria,
    requiredChecks,
    reviewScope: [
      "src/geometry.js",
      "test/geometry.test.js",
    ],
  });

  report.gate = {
    status: result.status,
    attempt: result.attempt,
    reviewerThreadIds: result.reviewerThreadIds,
    trace: result.trace,
  };
  report.finalTask = board.task;
  report.comments = board.comments;
  report.autoCompleted = board.task.status === "done";
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = String(appServer.lastStderr ?? "").split("\n").slice(-3).join("\n");

  // Independent ground truth, read straight off disk.
  const finalEvidence = await collectEvidence({ workspacePath, requiredChecks, timeoutMs }).catch(() => null);
  report.groundTruth = finalEvidence
    ? {
        checks: finalEvidence.checks.map((c) => ({ command: c.command, passed: c.passed, exitCode: c.exitCode })),
        gitDirty: finalEvidence.git?.dirty ?? null,
        changedFiles: finalEvidence.git?.changedFiles ?? null,
      }
    : null;
  report.sourceAfter = fs.existsSync(path.join(workspacePath, "src", "geometry.js"))
    ? fs.readFileSync(path.join(workspacePath, "src", "geometry.js"), "utf8")
    : null;
  report.workspaceFiles = fs.existsSync(workspacePath) ? fs.readdirSync(workspacePath).sort() : null;

  await appServer.stop();
  console.log(JSON.stringify(report, null, 2));
}
