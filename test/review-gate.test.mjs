import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMachineEvidence,
  deriveReviewVerdict,
  executeNativeReviewGate,
  runNativeReview,
} from "../src/core/review-gate.mjs";

const PASS_REVIEW = "I inspected the real files. No in-scope defect remains.\nVERDICT: PASS";
const FAIL_REVIEW = "src/math.js:25-26 still returns the mirrored signs.\nVERDICT: FAIL";

class Board {
  constructor() { this.task = { id: "T1", version: 1, status: "todo" }; this.events = []; this.binding = null; }
  async getTask() { return structuredClone(this.task); }
  async moveTask(id, status, version, binding) {
    assert.equal(id, "T1");
    assert.equal(version, this.task.version);
    this.task.status = status;
    this.task.version += 1;
    if (binding) this.binding = binding;
    this.events.push({ type: "move", status });
  }
  async addComment(_id, c) { this.events.push({ type: "comment", body: c.body }); }
}

/**
 * Fake app server that behaves like the real one for the Gate's purposes.
 *
 * `readThread` is the source of the Gate's identity evidence, so it must be
 * present: a fake server that cannot report its own thread is exactly the
 * "identity check with no evidence behind it" this revision fixed.
 */
function fakeAppServer({
  reviews,
  lifecycle = { entered: 1, exited: 1 },
  turnStatus = "completed",
  boundThreadId = "exec-A",
  boundCwd = "D:/ws",
}) {
  const calls = [];
  let turn = 0;
  let thread = 0;
  return {
    calls,
    async startThread(params) {
      calls.push({ method: "thread/start", params });
      assert.equal(params.sandbox, "read-only", "reviewer thread must be read-only");
      thread += 1;
      return { thread: { id: `reviewer-${thread}` }, sandbox: { type: "readOnly" } };
    },
    async readThread({ threadId }) {
      calls.push({ method: "thread/read", params: { threadId } });
      return { thread: { id: boundThreadId, cwd: boundCwd } };
    },
    async startReview(params) {
      calls.push({ method: "review/start", params });
      assert.equal(params.delivery, "inline", "detached review must never be used");
      assert.equal(params.target.type, "custom", "the review contract travels in a custom target");
      turn += 1;
      return { reviewThreadId: params.threadId, turn: { id: `review-turn-${turn}` } };
    },
    async waitForReview() {
      return {
        turnId: `review-turn-${turn}`,
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

const healthyEvidence = { identityMatches: true, allChecksPassed: true, checks: [{ passed: true }], failedChecks: [] };

// ------------------------------------------------------------ layer A/C
test("machine evidence blocks a review that is not independent", () => {
  const r = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "A", reviewerSandbox: "readOnly",
    reviewTurnStatus: "completed", reviewMode: { entered: 1, exited: 1 }, evidence: healthyEvidence,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.match(r.reason, /not independent/);
});

test("machine evidence blocks a reviewer that is not read-only", () => {
  const r = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "B", reviewerSandbox: "workspaceWrite",
    reviewTurnStatus: "completed", reviewMode: { entered: 1, exited: 1 }, evidence: healthyEvidence,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.match(r.reason, /read-only/);
});

test("machine evidence blocks a missing review lifecycle", () => {
  const r = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "B", reviewerSandbox: "readOnly",
    reviewTurnStatus: "completed", reviewMode: { entered: 0, exited: 0 }, evidence: healthyEvidence,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.match(r.reason, /lifecycle/);
});

test("machine evidence blocks an aborted review turn", () => {
  const r = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "B", reviewerSandbox: "readOnly",
    reviewTurnStatus: "interrupted", reviewMode: { entered: 1, exited: 1 }, evidence: healthyEvidence,
  });
  assert.equal(r.verdict, "BLOCKED");
  assert.match(r.reason, /did not complete/);
});

test("failing machine checks are FAIL even when the reviewer said PASS", () => {
  const machine = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "B", reviewerSandbox: "readOnly",
    reviewTurnStatus: "completed", reviewMode: { entered: 1, exited: 1 },
    evidence: { identityMatches: true, allChecksPassed: false, failedChecks: [{ command: "node --test", exitCode: 1 }] },
  });
  assert.equal(machine.verdict, "FAIL");

  const derived = deriveReviewVerdict({
    verdict: { verdict: "PASS", marker: "VERDICT: PASS" },
    machineFailure: machine,
    evidence: { identityMatches: true },
  });
  assert.equal(derived.verdict, "FAIL");
  assert.equal(derived.failureKind, "deterministic_verification");
  assert.deepEqual(derived.deterministicDetail, [{ command: "node --test", exitCode: 1 }]);
});

// ------------------------------------------------------------ layer B/C
test("a PASS requires both the marker and passing machine evidence", () => {
  const machine = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "B", reviewerSandbox: "readOnly",
    reviewTurnStatus: "completed", reviewMode: { entered: 1, exited: 1 }, evidence: healthyEvidence,
  });
  assert.equal(machine, null);
  const derived = deriveReviewVerdict({
    verdict: { verdict: "PASS", marker: "VERDICT: PASS" },
    machineFailure: machine,
    evidence: { identityMatches: true },
  });
  assert.equal(derived.verdict, "PASS");
});

test("an unmarked review is BLOCKED, never PASS", () => {
  const machine = checkMachineEvidence({
    executorThreadId: "A", reviewerThreadId: "B", reviewerSandbox: "readOnly",
    reviewTurnStatus: "completed", reviewMode: { entered: 1, exited: 1 }, evidence: healthyEvidence,
  });
  const derived = deriveReviewVerdict({
    verdict: { verdict: null, reason: "no marker" },
    machineFailure: machine,
    evidence: { identityMatches: true },
  });
  assert.equal(derived.verdict, "BLOCKED");
  assert.match(derived.reason, /unambiguous verdict/);
});

// ------------------------------------------------------------ reviewer run
test("runNativeReview uses a fresh read-only thread and native review/start", async () => {
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const run = await runNativeReview({
    appServer,
    executorBinding: { threadId: "exec-A", workspacePath: "D:/ws" },
    task: { id: "T1" },
    evidence: healthyEvidence,
    model: "m",
  });
  assert.equal(run.reviewerThreadId, "reviewer-1");
  assert.notEqual(run.reviewerThreadId, "exec-A");
  assert.equal(run.sandbox, "readOnly");
  assert.match(run.reviewText, /VERDICT: PASS/);
  assert.deepEqual(appServer.calls.map((c) => c.method), ["thread/start", "review/start"]);
});

test("runNativeReview refuses to reuse the executor thread id", async () => {
  const appServer = {
    async startThread() { return { thread: { id: "exec-A" }, sandbox: { type: "readOnly" } }; },
  };
  await assert.rejects(
    () => runNativeReview({
      appServer, executorBinding: { threadId: "exec-A", workspacePath: "D:/ws" },
      task: {}, evidence: {}, model: "m",
    }),
    /must differ from the executor thread/,
  );
});

// ------------------------------------------------------------ end to end
test("gate runs native FAIL -> same executor repair -> new reviewer -> PASS", async () => {
  const board = new Board();
  const executorBinding = {
    threadId: "exec-A", codexProjectId: "p", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "D:/ws",
  };
  let repairs = 0;
  const executor = {
    binding: executorBinding,
    async collectHandoff() { return structuredClone(healthyEvidence); },
    async repair() { repairs += 1; },
  };
  const appServer = fakeAppServer({ reviews: (n) => (n === 1 ? FAIL_REVIEW : PASS_REVIEW) });

  const result = await executeNativeReviewGate({
    taskId: "T1", task: await board.getTask(), executor, appServer, taskboard: board, model: "m",
  });

  assert.equal(result.status, "READY_FOR_ACCEPTANCE");
  assert.equal(result.attempt, 2);
  assert.equal(repairs, 1);
  assert.equal(board.task.status, "in_review");
  assert.notEqual(board.task.status, "done", "PASS must not auto-complete the task");
  assert.equal(board.binding.threadId, "exec-A", "executor binding unchanged");

  const [b, c] = result.reviewerThreadIds;
  assert.notEqual(b, c, "the second attempt needs a new reviewer thread");
  assert.notEqual(b, "exec-A");
  assert.notEqual(c, "exec-A");
  assert.equal(result.trace.some((t) => t.event === "executor.repaired" && t.executorThreadId === "exec-A"), true);
});

test("gate blocks when the reviewer never emits a verdict", async () => {
  const board = new Board();
  const executor = {
    binding: { threadId: "exec-A", workspacePath: "D:/ws" },
    async collectHandoff() { return { ...healthyEvidence }; },
    async repair() { throw new Error("repair must not run for BLOCKED"); },
  };
  const appServer = fakeAppServer({ reviews: () => "I looked around but did not conclude." });
  const result = await executeNativeReviewGate({
    taskId: "T1", task: await board.getTask(), executor, appServer, taskboard: board, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(board.task.status, "blocked");
  assert.notEqual(board.task.status, "done");
});

test("gate blocks when the review lifecycle never appears", async () => {
  const board = new Board();
  const executor = {
    binding: { threadId: "exec-A", workspacePath: "D:/ws" },
    async collectHandoff() { return { ...healthyEvidence }; },
    async repair() { throw new Error("repair must not run for BLOCKED"); },
  };
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW, lifecycle: { entered: 0, exited: 0 } });
  const result = await executeNativeReviewGate({
    taskId: "T1", task: await board.getTask(), executor, appServer, taskboard: board, model: "m",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(board.task.status, "blocked");
});

test("gate fails and never auto-completes when machine verification fails", async () => {
  const board = new Board();
  let repairs = 0;
  const executor = {
    binding: { threadId: "exec-A", workspacePath: "D:/ws" },
    async collectHandoff() {
      return { identityMatches: true, allChecksPassed: false, checks: [], failedChecks: [{ command: "node --test", exitCode: 1 }] };
    },
    async repair() { repairs += 1; },
  };
  // The reviewer claims PASS on every attempt; the machine evidence disagrees.
  const appServer = fakeAppServer({ reviews: () => PASS_REVIEW });
  const result = await executeNativeReviewGate({
    taskId: "T1", task: await board.getTask(), executor, appServer, taskboard: board, model: "m", maxAttempts: 2,
  });
  assert.equal(result.status, "BLOCKED", "exhausted attempts end BLOCKED");
  assert.equal(repairs, 1, "the executor was asked to repair");
  assert.equal(board.task.status, "blocked");
  assert.equal(result.trace.some((t) => t.failureKind === "deterministic_verification"), true);
});
