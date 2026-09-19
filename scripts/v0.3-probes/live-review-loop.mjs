/**
 * Real end-to-end review loop on this machine.
 *
 *   Executor thread A  (workspace-write, real model)
 *        -> handoff + machine evidence (real test run)
 *   Reviewer thread B  (read-only, outputSchema) -> FAIL
 *        -> Taskboard todo -> in_progress
 *   Executor thread A  repairs the real defect (same thread, no new executor)
 *   Reviewer thread C  (read-only, outputSchema) -> PASS
 *        -> Taskboard in_review, gate READY_FOR_ACCEPTANCE
 *
 * The workspace under test is built by scripts/make-fixture.mjs so the defect
 * is real and the fix is a real file change. Nothing is mocked except the
 * Taskboard (an in-memory board), because the user's dashi must not be started.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";
import { executeNativeReviewGate } from "../src/core/review-gate.mjs";

const execFileAsync = promisify(execFile);

const workspacePath = process.env.FUSION_POC_WORKSPACE;
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 900_000);

if (!workspacePath || !model) {
  console.error("Set FUSION_POC_WORKSPACE and FUSION_POC_MODEL.");
  process.exit(2);
}

class MemoryBoard {
  constructor() { this.task = { id: "LIVE-1", version: 1, status: "todo", title: "Fix the cross-product defect" }; this.comments = []; }
  async getTask() { return structuredClone(this.task); }
  async moveTask(id, status, version) {
    if (version !== this.task.version) throw new Error(`version conflict: ${version} != ${this.task.version}`);
    this.task.status = status;
    this.task.version += 1;
    return structuredClone(this.task);
  }
  async addComment(_id, comment) { this.comments.push({ body: comment.body, threadId: comment.binding?.threadId ?? null }); }
}

async function runWorkspaceTests() {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--test"], { cwd: workspacePath, timeout: 120_000 });
    return { passed: true, pass: stdout.match(/^ℹ pass (\d+)$/m)?.[1] ?? null, fail: stdout.match(/^ℹ fail (\d+)$/m)?.[1] ?? null };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return {
      passed: false,
      pass: output.match(/^ℹ pass (\d+)$/m)?.[1] ?? null,
      fail: output.match(/^ℹ fail (\d+)$/m)?.[1] ?? null,
      detail: output.split("\n").filter((l) => l.startsWith("✖") || /AssertionError/.test(l)).slice(0, 4).join(" | "),
    };
  }
}

const appServer = new AppServerStdio({ cwd: workspacePath, timeoutMs: 120_000 });
const report = { workspacePath, model, modelProvider, codexHome: process.env.CODEX_HOME ?? null, events: [] };

try {
  await appServer.start();

  // ---- Executor thread A --------------------------------------------------
  const executorThread = await appServer.startThread({
    cwd: workspacePath, model, modelProvider, sandbox: "workspace-write",
  });
  const executorThreadId = executorThread?.thread?.id ?? null;
  report.executorThreadId = executorThreadId;

  const executorBinding = {
    threadId: executorThreadId,
    codexProjectId: "fusion-v3",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  };

  const executor = {
    binding: executorBinding,
    async collectHandoff() {
      const tests = await runWorkspaceTests();
      report.events.push({ event: "handoff", tests });
      return {
        testsPassed: tests.passed,
        identityMatches: true,
        workspacePath,
        pass: tests.pass,
        fail: tests.fail,
        deterministicDetail: tests.detail ?? null,
      };
    },
    async repair({ reviewerFindings, attempt }) {
      const instruction = [
        "You are the executor for this Node.js project.",
        `Workspace: ${workspacePath}`,
        "An independent reviewer rejected the previous attempt with these findings:",
        JSON.stringify(reviewerFindings, null, 2),
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
        agentText: text.slice(0, 2_000),
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
    reviewTimeoutMs: timeoutMs,
  });

  report.gate = {
    status: result.status,
    attempt: result.attempt,
    reviewerThreadIds: result.reviewerThreadIds,
    trace: result.trace,
    finalReview: result.review ?? null,
  };
  report.finalTask = board.task;
  report.comments = board.comments;
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = (appServer.lastStderr ?? "").split("\n").slice(-3).join("\n");
  report.workspaceAfter = await runWorkspaceTests();
  report.workspaceFiles = fs.existsSync(workspacePath)
    ? fs.readdirSync(workspacePath).sort()
    : null;
  report.sourceAfter = (() => {
    const file = path.join(workspacePath, "src", "math.js");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  })();
  await appServer.stop();
  console.log(JSON.stringify(report, null, 2));
}
