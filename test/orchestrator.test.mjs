import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTEMPT_PREFIX,
  acceptTask,
  readTaskState,
  resolveResumeAction,
  resumeExecutorThread,
  runTaskThroughGate,
} from "../src/core/orchestrator.mjs";

/**
 * A Taskboard that behaves like dashi's versioned, comment-bearing contract.
 * Status transitions and versions are real so the orchestrator's state machine
 * is exercised rather than bypassed.
 */
class Board {
  constructor({ status = "todo", threadId = "exec-A", comments = [] } = {}) {
    this.task = {
      id: "T1",
      version: 1,
      status,
      threadBinding: threadId
        ? {
            threadId,
            codexProjectId: "p",
            codexProjectKind: "local",
            codexHostId: "local",
            workspacePath: "D:/ws",
          }
        : null,
    };
    this.comments = comments.map((body, i) => ({ id: `c${i}`, body, threadBinding: null }));
    this.moves = [];
  }
  async getTask() { return structuredClone(this.task); }
  async request(path) {
    if (path.endsWith("/comments")) return { comments: structuredClone(this.comments) };
    throw new Error(`unexpected request ${path}`);
  }
  async moveTask(id, status, version, binding) {
    assert.equal(version, this.task.version, `version conflict: ${version} != ${this.task.version}`);
    this.task.status = status;
    this.task.version += 1;
    if (binding) this.task.threadBinding = structuredClone(binding);
    this.moves.push(status);
    return structuredClone(this.task);
  }
  async addComment(_id, comment) {
    this.comments.push({ id: `c${this.comments.length}`, body: comment.body, threadBinding: comment.binding ?? null });
    return { id: `c${this.comments.length}`, version: 1 };
  }
}

const PASS_REVIEW = "Inspected the files. No in-scope defect remains.\nVERDICT: PASS";
const FAIL_REVIEW = "src/example.js:8 divide still returns Infinity.\nVERDICT: FAIL";

/** Real-shaped fake app server: reports its own thread, so identity is real. */
function fakeAppServer({
  reviews,
  lifecycle = { entered: 1, exited: 1 },
  turnStatus = "completed",
  threadCwd = "D:/ws",
} = {}) {
  const reviewerThreads = [];
  const resumed = [];
  let turn = 0;
  return {
    reviewerThreads,
    resumed,
    async startThread(params) {
      assert.equal(params.sandbox, "read-only", "the reviewer thread must be read-only");
      const id = `reviewer-${reviewerThreads.length + 1}`;
      reviewerThreads.push(id);
      return { thread: { id }, sandbox: { type: "readOnly" } };
    },
    async readThread({ threadId }) {
      return { thread: { id: threadId, cwd: threadCwd } };
    },
    async resumeThread({ threadId }) {
      resumed.push(threadId);
      return { thread: { id: threadId }, cwd: threadCwd, sandbox: { type: "workspaceWrite" } };
    },
    async startReview({ threadId }) {
      turn += 1;
      return { reviewThreadId: threadId, turn: { id: `rev-turn-${turn}` } };
    },
    async waitForReview() {
      return {
        turnId: `rev-turn-${turn}`,
        status: turnStatus,
        error: null,
        items: [],
        notifications: [],
        review: reviews(turn),
        reviewMode: lifecycle,
      };
    },
  };
}

const healthy = () => ({
  identityMatches: true,
  allChecksPassed: true,
  checks: [{ command: "node --test", passed: true, exitCode: 0 }],
  failedChecks: [],
  fingerprint: { digest: "d" },
});

function executorFor(attempts = {}) {
  const binding = {
    threadId: "exec-A",
    codexProjectId: "p",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "D:/ws",
  };
  const record = { repairs: [], handoffs: [] };
  return {
    binding,
    record,
    async collectHandoff({ attempt }) {
      record.handoffs.push({ attempt, threadId: binding.threadId });
      const passed = attempts.passFromAttempt ? attempt >= attempts.passFromAttempt : true;
      return { ...healthy(), allChecksPassed: passed, failedChecks: passed ? [] : [{ command: "node --test", exitCode: 1 }] };
    },
    async repair({ attempt }) {
      record.repairs.push({ attempt, threadId: binding.threadId });
    },
  };
}

// ------------------------------------------------------------ A: statuses
test("backlog and canceled never resolve to run", () => {
  assert.notEqual(resolveResumeAction("backlog"), "run");
  assert.equal(resolveResumeAction("backlog"), "not_approved");
  assert.notEqual(resolveResumeAction("canceled"), "run");
  assert.equal(resolveResumeAction("canceled"), "canceled");
});

test("every dashi status maps to the intended action", () => {
  const expected = {
    backlog: "not_approved",
    todo: "run",
    in_progress: "run",
    in_review: "await_human",
    blocked: "blocked",
    done: "done",
    canceled: "canceled",
  };
  for (const [status, action] of Object.entries(expected)) {
    assert.equal(resolveResumeAction(status), action, `${status} -> ${action}`);
  }
});

test("an unrecognized status fails closed instead of running", () => {
  for (const status of ["archived", "weird", "", null, undefined, "IN_PROGRESS"]) {
    assert.notEqual(resolveResumeAction(status), "run", `status ${JSON.stringify(status)} must not run`);
  }
});

test("readTaskState refuses to run a backlog task and says why", async () => {
  const state = await readTaskState({ taskboard: new Board({ status: "backlog" }), taskId: "T1" });
  assert.equal(state.resume.action, "not_approved");
  assert.equal(state.resume.mustNotRerunExecutor, true);
  assert.equal(state.resume.mustNotRerunReviewer, true);
  assert.match(state.resume.reason, /not approved/i);
});

test("readTaskState refuses to run a canceled task", async () => {
  const state = await readTaskState({ taskboard: new Board({ status: "canceled" }), taskId: "T1" });
  assert.equal(state.resume.action, "canceled");
  assert.equal(state.resume.mustNotRerunExecutor, true);
});

test("a backlog task performs no work when run through the gate", async () => {
  const board = new Board({ status: "backlog" });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.attemptedWork, false);
  assert.equal(result.resumed, true);
  assert.equal(executor.record.handoffs.length, 0, "no executor work");
  assert.equal(appServer.reviewerThreads.length, 0, "no reviewer thread");
  assert.equal(board.task.status, "backlog", "the board was not advanced");
});

test("a canceled task performs no work when run through the gate", async () => {
  const board = new Board({ status: "canceled" });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.attemptedWork, false);
  assert.equal(result.status, "CANCELED");
  assert.equal(executor.record.handoffs.length, 0);
  assert.equal(appServer.reviewerThreads.length, 0);
});

test("todo and in_progress remain runnable", async () => {
  for (const status of ["todo", "in_progress"]) {
    const board = new Board({ status });
    const executor = executorFor();
    const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
    const result = await runTaskThroughGate({
      taskboard: board, taskId: "T1", executor, appServer, model: "m",
    });
    assert.equal(result.attemptedWork, true, `${status} should run`);
    assert.equal(result.status, "READY_FOR_ACCEPTANCE");
  }
});

// ------------------------------------------------- E: thread/state machine
test("PASS reaches READY_FOR_ACCEPTANCE and never done", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.status, "READY_FOR_ACCEPTANCE");
  assert.equal(board.task.status, "in_review");
  assert.notEqual(board.task.status, "done");
  assert.ok(!board.moves.includes("done"));
});

test("reviewer FAIL returns to the SAME executor thread, then a NEW reviewer passes", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: (n) => (n === 1 ? FAIL_REVIEW : PASS_REVIEW) });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });

  assert.equal(result.status, "READY_FOR_ACCEPTANCE");
  assert.equal(executor.record.repairs.length, 1, "exactly one repair");
  assert.equal(executor.record.repairs[0].threadId, "exec-A", "repair used thread A");
  assert.equal(executor.binding.threadId, "exec-A", "executor binding unchanged by repair");

  const [b, c] = appServer.reviewerThreads;
  assert.ok(b && c, "two reviewer threads were created");
  assert.notEqual(b, c, "each attempt gets its own reviewer thread");
  assert.notEqual(b, "exec-A");
  assert.notEqual(c, "exec-A");
});

test("executor binding is identical before and after repair", async () => {
  const board = new Board();
  const executor = executorFor();
  const before = structuredClone(executor.binding);
  const appServer = fakeAppServer({ reviews: (n) => (n === 1 ? FAIL_REVIEW : PASS_REVIEW) });
  await runTaskThroughGate({ taskboard: board, taskId: "T1", executor, appServer, model: "m" });
  assert.deepEqual(executor.binding, before);
  assert.equal(board.task.threadBinding.threadId, "exec-A");
});

test("an ambiguous reviewer verdict is BLOCKED and never repairs", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => "VERDICT: PASS\nVERDICT: FAIL" });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(board.task.status, "blocked");
  assert.equal(executor.record.repairs.length, 0);
});

test("a duplicate PASS marker is BLOCKED", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => "VERDICT: PASS\n(restated)\nVERDICT: PASS" });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(executor.record.repairs.length, 0);
});

test("a missing review lifecycle is BLOCKED", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW, lifecycle: { entered: 0, exited: 0 } });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
});

test("a non-independent reviewer is BLOCKED", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  // Force the reviewer thread to collide with the executor thread.
  appServer.startThread = async () => ({ thread: { id: "exec-A" }, sandbox: { type: "readOnly" } });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(board.task.status, "blocked");
});

test("a non-read-only reviewer thread is BLOCKED", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  appServer.startThread = async () => ({ thread: { id: "reviewer-x" }, sandbox: { type: "workspaceWrite" } });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
});

/**
 * Machine evidence is checked before the reviewer's opinion, so a reviewer that
 * claims PASS cannot release a task whose tests fail. Here the reviewer says
 * PASS on every attempt while verification fails, so attempts are exhausted.
 */
test("failing machine evidence overrides a reviewer PASS and never auto-completes", async () => {
  const board = new Board();
  const executor = executorFor();
  // Force verification to fail on every attempt, regardless of the reviewer.
  executor.collectHandoff = async ({ attempt }) => ({
    ...healthy(),
    allChecksPassed: false,
    failedChecks: [{ command: "node --test", exitCode: 1 }],
    attempt,
  });
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m", maxAttempts: 2,
  });
  assert.equal(result.status, "BLOCKED", "exhausted attempts end BLOCKED");
  assert.equal(board.task.status, "blocked");
  assert.notEqual(board.task.status, "done");
  assert.equal(executor.record.repairs.length, 1, "the executor was asked to repair");
  assert.ok(result.gate.trace.some((t) => t.failureKind === "deterministic_verification"));
});

test("machine evidence passes only when the real exit code is zero", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  const recorded = result.attempts.at(-1);
  assert.equal(result.status, "READY_FOR_ACCEPTANCE");
  assert.equal(recorded.machineEvidence.allChecksPassed, true);
  assert.deepEqual(recorded.machineEvidence.failedChecks, []);
});

test("max attempts is enforced: three FAILs end BLOCKED after three repairs", async () => {
  const board = new Board();
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => FAIL_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m", maxAttempts: 3,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(board.task.status, "blocked");
  assert.equal(appServer.reviewerThreads.length, 3, "one reviewer per attempt");
  assert.equal(executor.record.repairs.length, 2, "no repair after the final failed attempt");
  assert.equal(new Set(appServer.reviewerThreads).size, 3, "reviewers are all distinct");
  assert.ok(appServer.reviewerThreads.every((id) => id !== "exec-A"));
});

// ------------------------------------------------------- D: resume/restart
test("resume reattaches to the durable thread and never creates a new executor", async () => {
  // A restart is identified by *durable attempt history*, not by the status
  // alone: a task that is in_progress but has never been reviewed is a first
  // run whose thread was just created and cannot be resumed yet.
  const board = new Board({ status: "in_progress", threadId: "exec-A" });
  board.comments.push({
    id: "c-attempt-1",
    body: `${ATTEMPT_PREFIX}${JSON.stringify({
      attempt: 1, executorThreadId: "exec-A", reviewerThreadId: "reviewer-1", verdict: "FAIL",
    })}`,
    threadBinding: null,
  });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  await runTaskThroughGate({ taskboard: board, taskId: "T1", executor, appServer, model: "m" });
  assert.deepEqual(appServer.resumed, ["exec-A"], "resume targeted the bound thread");
  assert.equal(executor.binding.threadId, "exec-A");
});

/**
 * Regression for a real failure observed in the live Dashi E2E: the first run of
 * a brand-new task called `thread/resume` on a thread that had not run a turn
 * yet, and the server rejected it with `-32600 no rollout found`, blocking the
 * task before any work happened.
 */
test("a first run does not attempt thread/resume", async () => {
  const board = new Board({ status: "todo", threadId: null });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({
    taskboard: board, taskId: "T1", executor, appServer, model: "m",
  });
  assert.deepEqual(appServer.resumed, [], "no resume on a first run");
  assert.equal(result.attemptedWork, true);
  assert.equal(result.status, "READY_FOR_ACCEPTANCE");
});

test("resume refuses when the executor presents a different thread than the binding", async () => {
  const state = { executorThreadId: "exec-A" };
  const executor = { binding: { threadId: "exec-B", workspacePath: "D:/ws" } };
  const result = await resumeExecutorThread({ appServer: {}, state, executor });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /binding conflict/);
  assert.equal(executor.binding.threadId, "exec-B", "a conflicting binding is not silently rewritten");
});

test("a failed thread/resume blocks the task instead of starting fresh work", async () => {
  const board = new Board({ status: "in_progress", threadId: "exec-A" });
  board.comments.push({
    id: "c-attempt-1",
    body: `${ATTEMPT_PREFIX}${JSON.stringify({
      attempt: 1, executorThreadId: "exec-A", reviewerThreadId: "reviewer-1", verdict: "FAIL",
    })}`,
    threadBinding: null,
  });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  appServer.resumeThread = async () => { throw new Error("thread not found"); };
  const result = await runTaskThroughGate({ taskboard: board, taskId: "T1", executor, appServer, model: "m" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.attemptedWork, false);
  assert.equal(board.task.status, "blocked");
  assert.equal(appServer.reviewerThreads.length, 0);
});

test("a task already in_review is not re-executed on restart", async () => {
  const board = new Board({ status: "in_review", threadId: "exec-A" });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({ taskboard: board, taskId: "T1", executor, appServer, model: "m" });
  assert.equal(result.status, "READY_FOR_ACCEPTANCE");
  assert.equal(result.resumed, true);
  assert.equal(result.attemptedWork, false);
  assert.equal(executor.record.handoffs.length, 0);
  assert.deepEqual(appServer.resumed, [], "no resume needed for a task awaiting a human");
});

test("a blocked task stays blocked on restart and runs nothing", async () => {
  const board = new Board({ status: "blocked", threadId: "exec-A" });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await runTaskThroughGate({ taskboard: board, taskId: "T1", executor, appServer, model: "m" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.attemptedWork, false);
  assert.equal(board.task.status, "blocked");
  assert.equal(executor.record.handoffs.length, 0);
  assert.equal(appServer.reviewerThreads.length, 0);
});

test("executorThreadId survives a restart, reconstructed from durable state", async () => {
  const board = new Board({ status: "in_progress", threadId: "exec-A" });
  const attemptRecord = {
    attempt: 1,
    executorThreadId: "exec-A",
    reviewerThreadId: "reviewer-1",
    verdict: "FAIL",
    at: new Date().toISOString(),
  };
  board.comments.push({
    id: "c-attempt",
    body: `${ATTEMPT_PREFIX}${JSON.stringify(attemptRecord)}`,
    threadBinding: { threadId: "reviewer-1" },
  });

  const first = await readTaskState({ taskboard: board, taskId: "T1" });
  assert.equal(first.executorThreadId, "exec-A");
  assert.equal(first.attempts.length, 1);
  assert.equal(first.lastAttempt.reviewerThreadId, "reviewer-1");

  // A restarted process reads the same durable state.
  const second = await readTaskState({ taskboard: board, taskId: "T1" });
  assert.equal(second.executorThreadId, first.executorThreadId);
  assert.equal(second.lastAttempt.reviewerThreadId, "reviewer-1");
});

// ----------------------------------------------------- human acceptance gate
test("human acceptance is the only path to done, and requires in_review", async () => {
  const board = new Board({ status: "in_progress", threadId: "exec-A" });
  await assert.rejects(
    () => acceptTask({ taskboard: board, taskId: "T1", binding: board.task.threadBinding }),
    /requires the task to be in_review/,
  );

  const passed = new Board({ status: "in_progress", threadId: "exec-A" });
  const executor = executorFor();
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  await runTaskThroughGate({ taskboard: passed, taskId: "T1", executor, appServer, model: "m" });
  assert.equal(passed.task.status, "in_review");

  const done = await acceptTask({ taskboard: passed, taskId: "T1", binding: passed.task.threadBinding });
  assert.equal(done.status, "done");
});

test("acceptance is refused when the last verdict was not PASS", async () => {
  const board = new Board({ status: "in_review", threadId: "exec-A" });
  board.comments.push({
    id: "c1",
    body: `${ATTEMPT_PREFIX}${JSON.stringify({ attempt: 1, executorThreadId: "exec-A", reviewerThreadId: "reviewer-1", verdict: "FAIL" })}`,
    threadBinding: null,
  });
  await assert.rejects(
    () => acceptTask({ taskboard: board, taskId: "T1", binding: board.task.threadBinding }),
    /refusing to accept/,
  );
});
