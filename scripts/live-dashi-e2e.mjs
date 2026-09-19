/**
 * Real, disposable Dashi end-to-end run -- including process-restart semantics.
 *
 * Nothing is mocked: a real dashi instance, a real `codex app-server`, real
 * model turns, Codex's native `review/start`, and a real workspace on disk whose
 * test command really fails and then really passes.
 *
 * Modes (env FUSION_POC_MODE):
 *
 *   fresh   create a disposable workspace task on dashi, then run the gate:
 *           Executor A -> machine evidence FAIL -> Reviewer B FAIL
 *           -> SAME Executor A repairs -> machine evidence PASS
 *           -> fresh Reviewer C PASS -> READY_FOR_ACCEPTANCE
 *
 *   crash   same as fresh, but the process exits from inside repair(), before it
 *           touches the workspace. Models "Fusion died after Reviewer B
 *           rejected the work".
 *
 *   resume  a NEW process: read the task from dashi, thread/resume(A), continue.
 *           Must reuse Executor A and never create Executor B.
 *
 *   verify  a NEW process against a task that already reached
 *           READY_FOR_ACCEPTANCE: must report await_human and do no work at all.
 *           Any app-server call is a failure.
 *
 *   verify-blocked  a NEW process against a BLOCKED task: must stay blocked.
 *
 * Framing, stated plainly: on the first attempt the executor is scoped to
 * inspect and report, so the defect shipped in the fixture is still present and
 * the machine evidence genuinely fails. That is what makes FAIL -> repair -> PASS
 * deterministic; a model cannot be forced to write a bug on demand. Every exit
 * code, reviewer verdict and thread id here is real.
 *
 * Env: FUSION_POC_TASKBOARD_URL, FUSION_POC_PROJECT_ID, FUSION_POC_WORKSPACE,
 *      FUSION_POC_MODEL, FUSION_POC_CODEX_HOME, FUSION_POC_STATE_FILE,
 *      FUSION_POC_TASK_ID, FUSION_POC_CRASH, FUSION_POC_TURN_TIMEOUT_MS
 */
import fs from "node:fs";
import { TaskboardHttp } from "../src/adapters/taskboard-http.mjs";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";
import { readTaskState, runTaskThroughGate } from "../src/core/orchestrator.mjs";
import { collectEvidence, fingerprintWorkspace } from "../src/core/evidence.mjs";

const baseUrl = process.env.FUSION_POC_TASKBOARD_URL;
const projectId = process.env.FUSION_POC_PROJECT_ID ?? "fusion-e2e";
const workspacePath = process.env.FUSION_POC_WORKSPACE;
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const codexHome = process.env.FUSION_POC_CODEX_HOME ?? "D:\\poc\\v2-codex-home";
const mode = process.env.FUSION_POC_MODE ?? "fresh";
const stateFile = process.env.FUSION_POC_STATE_FILE ?? "D:\\poc\\dashi-e2e-state.json";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 900000);

if (!baseUrl || !workspacePath || !model) {
  console.error("Set FUSION_POC_TASKBOARD_URL, FUSION_POC_WORKSPACE and FUSION_POC_MODEL.");
  process.exit(2);
}

const readState = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {});
const writeState = (patch) => {
  const next = { ...readState(), ...patch };
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), "utf8");
  return next;
};

const board = new TaskboardHttp({ baseUrl, actorId: "fusion-e2e", actorName: "Fusion E2E" });
const report = { mode, baseUrl, projectId, workspacePath, model, modelProvider, codexHome };

const acceptanceCriteria = [
  "The existing test suite must pass with no test weakened, skipped, deleted, or added.",
  "crossSign must match the orientation documented in its own docstring.",
  "No file outside the defective source file should need to change.",
];

const requiredChecks = [{ command: process.execPath, args: ["--test"], timeoutMs: 120000 }];
const reviewScope = ["src/geometry.js", "test/geometry.test.js"];

/** Counts every call, so a "did no work" claim is checkable rather than asserted. */
function countingAppServer(options) {
  const inner = new AppServerStdio(options);
  const counts = { start: 0, startThread: 0, resumeThread: 0, readThread: 0, startReview: 0, startTurn: 0 };
  return {
    counts,
    get lastStderr() { return inner.lastStderr; },
    async start(...a) { counts.start += 1; return inner.start(...a); },
    async stop(...a) { return inner.stop(...a); },
    async startThread(...a) { counts.startThread += 1; return inner.startThread(...a); },
    async resumeThread(...a) { counts.resumeThread += 1; return inner.resumeThread(...a); },
    async readThread(...a) { counts.readThread += 1; return inner.readThread(...a); },
    async startReview(...a) { counts.startReview += 1; return inner.startReview(...a); },
    async startTurn(...a) { counts.startTurn += 1; return inner.startTurn(...a); },
    async waitForTurn(...a) { return inner.waitForTurn(...a); },
    async waitForReview(...a) { return inner.waitForReview(...a); },
    async request(...a) { return inner.request(...a); },
    async notify(...a) { return inner.notify(...a); },
  };
}

/** An app server that must never be used; any call is recorded as a violation. */
function forbiddenAppServer() {
  const calls = [];
  const boom = (name) => (...args) => {
    calls.push({ method: name, args });
    throw new Error(`the app server must not be used in this mode, but ${name} was called`);
  };
  return {
    calls,
    start: boom("start"),
    stop: async () => {},
    startThread: boom("startThread"),
    resumeThread: boom("resumeThread"),
    readThread: boom("readThread"),
    startReview: boom("startReview"),
    startTurn: boom("startTurn"),
    waitForTurn: boom("waitForTurn"),
    waitForReview: boom("waitForReview"),
    request: boom("request"),
  };
}

/**
 * Build the executor for one run.
 *
 * `alreadyRejected` distinguishes a first run from a resumed one: when the board
 * already holds review attempts, the executor is there to repair, not to redo
 * the initial inspection.
 */
function makeExecutor({ appServer, binding, alreadyRejected }) {
  let baseline = fingerprintWorkspace(workspacePath);
  const record = { handoffs: [], repairs: [] };

  const runTurn = async (instruction) => {
    const started = await appServer.startTurn({
      threadId: binding.threadId,
      message: instruction,
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    });
    const done = await appServer.waitForTurn({
      threadId: binding.threadId, turnId: started.turn?.id ?? null, timeoutMs,
    });
    return {
      turnId: done.turnId,
      status: done.status,
      agentText: done.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n"),
    };
  };

  return {
    binding,
    record,
    async collectHandoff({ attempt }) {
      if (attempt === 1 && !alreadyRejected) {
        const turn = await runTurn([
          "You are the executor for the repository at this workspace.",
          `Workspace: ${workspacePath}`,
          "Read src/geometry.js and test/geometry.test.js and report what they do.",
          "Do NOT modify any file in this turn. This turn is inspection only.",
        ].join("\n"));
        record.handoffs.push({ attempt, threadId: binding.threadId, turnId: turn.turnId, status: turn.status, agentText: turn.agentText.slice(0, 600) });
      }
      const evidence = await collectEvidence({ workspacePath, requiredChecks, fingerprintBefore: baseline, timeoutMs });
      record.handoffs.push({
        attempt,
        allChecksPassed: evidence.allChecksPassed,
        exitCodes: evidence.checks.map((c) => ({ command: c.command, exitCode: c.exitCode })),
      });
      return evidence;
    },
    async repair({ reviewerFindings, attempt }) {
      if (process.env.FUSION_POC_CRASH === "before-repair") {
        record.repairs.push({ attempt, threadId: binding.threadId, crashed: true });
        writeState({ crashedAfterAttempt: attempt, crashedInRepairOnThread: binding.threadId });
        report.crash = {
          reason: "FUSION_POC_CRASH=before-repair: exiting before touching the workspace",
          attempt,
          executorThreadId: binding.threadId,
        };
        await appServer.stop();
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
      }
      baseline = fingerprintWorkspace(workspacePath);
      const turn = await runTurn([
        "You are the executor for the repository at this workspace.",
        `Workspace: ${workspacePath}`,
        "",
        "An independent reviewer rejected the current state. Its review:",
        "-----",
        String(reviewerFindings ?? "").slice(0, 6000),
        "-----",
        "",
        "Fix the real defect so the existing test suite passes.",
        "Do not weaken, skip, delete, or add tests. Do not add files.",
        "Run `node --test` yourself and report the result.",
      ].join("\n"));
      record.repairs.push({ attempt, threadId: binding.threadId, turnId: turn.turnId, status: turn.status, agentText: turn.agentText.slice(0, 800) });
    },
  };
}

async function modeFreshOrCrash() {
  try {
    await board.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: projectId, name: "Fusion disposable E2E", workspacePath }),
    });
  } catch { /* already exists is fine */ }

  let taskId = process.env.FUSION_POC_TASK_ID ?? null;
  if (!taskId) {
    const created = await board.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        title: "E2E: make crossSign honour its documented orientation",
        description: [
          "src/geometry.js documents that crossSign returns 1 for a counter-clockwise",
          "orientation and -1 for clockwise. The implementation returns the opposite.",
          "test/geometry.test.js asserts the documented behaviour and currently fails.",
          "",
          "Make the implementation match the documented contract. Do not modify the tests.",
        ].join("\n"),
        status: "todo",
        priority: "high",
      }),
    });
    taskId = created.task.id;
    report.taskCreated = { taskId, identifier: created.task.identifier, status: created.task.status, version: created.task.version };
  } else {
    report.taskReused = taskId;
  }
  report.taskId = taskId;
  writeState({ taskId, workspacePath, projectId, model });

  const appServer = countingAppServer({ cwd: workspacePath, timeoutMs: 120000, env: { CODEX_HOME: codexHome } });
  await appServer.start();

  const thread = await appServer.startThread({ cwd: workspacePath, model, modelProvider, sandbox: "workspace-write" });
  const executorThreadId = thread?.thread?.id ?? null;
  if (!executorThreadId) throw new Error("executor thread/start returned no thread id");
  report.executorThread = { threadId: executorThreadId, sandbox: thread?.sandbox?.type ?? null };

  const before = await board.getTask(taskId);
  const binding = {
    threadId: executorThreadId,
    codexProjectId: projectId,
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  };
  const claimed = await board.moveTask(taskId, "in_progress", before.version, binding);
  report.claim = {
    status: claimed.status,
    version: claimed.version,
    executorBindingPersisted: claimed.threadBinding?.threadId === executorThreadId,
  };
  writeState({ executorThreadId });

  const executor = makeExecutor({ appServer, binding, alreadyRejected: false });
  const result = await runTaskThroughGate({
    taskboard: board, taskId, executor, appServer, model, modelProvider,
    maxAttempts: 3, reviewTimeoutMs: timeoutMs, acceptanceCriteria, requiredChecks, reviewScope,
  });

  report.gate = {
    status: result.status,
    resumed: result.resumed,
    attemptedWork: result.attemptedWork,
    reviewerThreadIds: result.gate?.reviewerThreadIds ?? [],
    resumeAttempt: result.resumeAttempt ?? null,
    trace: (result.gate?.trace ?? []).filter((t) => t.event !== "review.run"),
  };
  report.executorRecord = executor.record;
  report.finalTaskStatus = result.task?.status ?? null;
  report.appServerCounts = appServer.counts;
  await appServer.stop();
}

async function modeResume() {
  const taskId = process.env.FUSION_POC_TASK_ID ?? readState().taskId;
  if (!taskId) throw new Error("no task id: run the crash/fresh mode first or set FUSION_POC_TASK_ID");
  report.taskId = taskId;

  const before = await readTaskState({ taskboard: board, taskId });
  report.stateBeforeResume = {
    status: before.task.status,
    version: before.task.version,
    executorThreadId: before.executorThreadId,
    attemptCount: before.attempts.length,
    attempts: before.attempts.map((a) => ({
      attempt: a.attempt, executorThreadId: a.executorThreadId,
      reviewerThreadId: a.reviewerThreadId, verdict: a.verdict,
    })),
    resume: before.resume,
  };

  const appServer = countingAppServer({ cwd: workspacePath, timeoutMs: 120000, env: { CODEX_HOME: codexHome } });
  await appServer.start();

  const binding = {
    threadId: before.executorThreadId,
    codexProjectId: projectId,
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  };
  const executor = makeExecutor({ appServer, binding, alreadyRejected: before.attempts.length > 0 });

  const result = await runTaskThroughGate({
    taskboard: board, taskId, executor, appServer, model, modelProvider,
    maxAttempts: 3, reviewTimeoutMs: timeoutMs, acceptanceCriteria, requiredChecks, reviewScope,
  });

  report.gate = {
    status: result.status,
    resumed: result.resumed,
    attemptedWork: result.attemptedWork,
    reviewerThreadIds: result.gate?.reviewerThreadIds ?? [],
    resumeAttempt: result.resumeAttempt ?? null,
  };
  report.appServerCounts = appServer.counts;
  report.executorRecord = executor.record;
  await appServer.stop();
}

async function modeVerify() {
  const taskId = process.env.FUSION_POC_TASK_ID ?? readState().taskId;
  if (!taskId) throw new Error("no task id available");
  report.taskId = taskId;

  const appServer = forbiddenAppServer();
  const executor = {
    binding: {
      threadId: readState().executorThreadId,
      workspacePath, codexProjectId: projectId, codexProjectKind: "local", codexHostId: "local",
    },
    async collectHandoff() { throw new Error("the executor must not run in this mode"); },
    async repair() { throw new Error("repair must not run in this mode"); },
  };

  let result = null;
  let error = null;
  try {
    result = await runTaskThroughGate({
      taskboard: board, taskId, executor, appServer, model, modelProvider,
      maxAttempts: 3, reviewTimeoutMs: timeoutMs, acceptanceCriteria, requiredChecks, reviewScope,
    });
  } catch (caught) {
    error = String(caught);
  }

  report.result = result
    ? { status: result.status, resumed: result.resumed, attemptedWork: result.attemptedWork, resume: result.resume ?? null }
    : null;
  report.error = error;
  report.appServerCalls = appServer.calls.map((c) => c.method);
  const after = await readTaskState({ taskboard: board, taskId });
  report.stateAfter = {
    status: after.task.status,
    version: after.task.version,
    executorThreadId: after.executorThreadId,
    attemptCount: after.attempts.length,
    resume: after.resume,
  };
}

try {
  if (mode === "fresh" || mode === "crash") await modeFreshOrCrash();
  else if (mode === "resume") await modeResume();
  else if (mode === "verify") await modeVerify();
  else if (mode === "verify-blocked") await modeVerify();
  else { console.error(`unknown FUSION_POC_MODE: ${mode}`); process.exit(2); }
} catch (error) {
  report.error = String(error);
}

if (report.taskId && !report.stateAfter) {
  try {
    const persisted = await readTaskState({ taskboard: board, taskId: report.taskId });
    report.persisted = {
      status: persisted.task.status,
      version: persisted.task.version,
      executorThreadId: persisted.task.threadBinding?.threadId ?? null,
      attempts: persisted.attempts.map((a) => ({
        attempt: a.attempt, executorThreadId: a.executorThreadId,
        reviewerThreadId: a.reviewerThreadId, verdict: a.verdict,
      })),
      resume: persisted.resume,
    };
  } catch (error) {
    report.verificationError = String(error);
  }
}

try {
  const evidence = await collectEvidence({ workspacePath, requiredChecks, timeoutMs });
  report.groundTruth = {
    checks: evidence.checks.map((c) => ({ command: c.command, exitCode: c.exitCode, passed: c.passed })),
    changedFiles: evidence.git?.changedFiles ?? null,
    isRepo: evidence.git?.isRepo ?? null,
  };
} catch (error) {
  report.groundTruthError = String(error);
}

console.log(JSON.stringify(report, null, 2));