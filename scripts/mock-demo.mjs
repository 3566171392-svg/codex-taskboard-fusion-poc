/**
 * Offline walkthrough of the Codex-native Review Gate MVP.
 *
 * Uses the REAL gate (`executeNativeReviewGate`) and the real verdict parser,
 * with a fake app server and an in-memory board. No model call, no network.
 *
 * What it demonstrates:
 *   FAIL -> same executor thread repairs -> NEW reviewer thread -> PASS
 *   PASS stops at READY_FOR_ACCEPTANCE; it never auto-marks `done`.
 *
 * The reviewer runs Codex's native `review/start` (inline on a fresh read-only
 * thread), not `turn/start.outputSchema`.
 */
import { executeNativeReviewGate } from "../src/core/review-gate.mjs";

class MemoryBoard {
  constructor() {
    this.task = { id: "demo-1", version: 1, status: "todo", title: "Restore the zero-divisor guard" };
    this.comments = [];
  }
  async getTask() { return structuredClone(this.task); }
  async moveTask(id, status, version) {
    if (version !== this.task.version) throw new Error(`version conflict: ${version} != ${this.task.version}`);
    this.task.status = status;
    this.task.version += 1;
    return structuredClone(this.task);
  }
  async addComment(_id, comment) { this.comments.push(comment.body); return comment; }
}

const board = new MemoryBoard();
const executorBinding = {
  threadId: "executor-thread-A",
  codexProjectId: "demo",
  codexProjectKind: "local",
  codexHostId: "local",
  workspacePath: "D:/demo",
};

let repairs = 0;
const executor = {
  binding: executorBinding,
  async collectHandoff({ attempt }) {
    // attempt 1: the real test suite fails; attempt 2: it passes.
    const passed = attempt > 1;
    return {
      identityMatches: true,
      allChecksPassed: passed,
      checks: [{ command: "node --test", passed, exitCode: passed ? 0 : 1 }],
      failedChecks: passed ? [] : [{ command: "node --test", exitCode: 1 }],
      fingerprint: { count: 7, digest: "demo-digest" },
    };
  },
  async repair() { repairs += 1; },
};

const reviewerThreads = [];
let reviewCount = 0;
const appServer = {
  async startThread({ sandbox }) {
    if (sandbox !== "read-only") throw new Error(`reviewer thread must be read-only, got ${sandbox}`);
    const id = `reviewer-thread-${reviewerThreads.length + 1}`;
    reviewerThreads.push(id);
    return { thread: { id }, sandbox: { type: "readOnly" } };
  },
  async startReview({ threadId, delivery, target }) {
    if (delivery !== "inline") throw new Error("the MVP only uses inline review on a separate thread");
    if (target?.type !== "custom") throw new Error("the review contract must travel in a custom target");
    reviewCount += 1;
    return { reviewThreadId: threadId, turn: { id: `review-turn-${reviewCount}` } };
  },
  async waitForReview() {
    const failed = reviewCount === 1;
    return {
      turnId: `review-turn-${reviewCount}`,
      status: "completed",
      error: null,
      items: [],
      notifications: [],
      reviewMode: { entered: 1, exited: 1 },
      review: failed
        ? "src/math.js:12 the zero-divisor guard is missing, divide(10,0) returns Infinity.\nVERDICT: FAIL"
        : "Inspected the real files. The guard is restored and the suite passes.\nVERDICT: PASS",
    };
  },
};

const result = await executeNativeReviewGate({
  taskId: "demo-1",
  task: await board.getTask(),
  executor,
  appServer,
  taskboard: board,
  model: "demo-model",
});

for (const event of result.trace) console.log(JSON.stringify(event));
console.log(JSON.stringify({
  executorThreadId: executorBinding.threadId,
  reviewerThreadIds: reviewerThreads,
  reviewerIsIndependent: reviewerThreads.every((id) => id !== executorBinding.threadId),
  reviewersAreDistinctPerAttempt: new Set(reviewerThreads).size === reviewerThreads.length,
  executorRepairedOnce: repairs === 1,
  executorThreadReused: result.trace.filter((t) => t.executorThreadId === executorBinding.threadId).length >= 2,
  finalTaskStatus: board.task.status,
  finalGateStatus: result.status,
  autoCompleted: board.task.status === "done",
  comments: board.comments,
}, null, 2));
