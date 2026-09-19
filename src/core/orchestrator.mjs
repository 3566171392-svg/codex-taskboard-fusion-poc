/**
 * Fusion Orchestrator: durable task state on the real dashi Taskboard.
 *
 * This is the thin layer that turns the Review Gate from a one-shot POC into
 * something that can manage a task across process restarts. It owns exactly
 * three responsibilities:
 *
 *   1. Read the task's authoritative state from the Taskboard (never from
 *      memory), so a restart resumes from durable state.
 *   2. Write Gate transitions and review-attempt records back to the Taskboard.
 *   3. Decide whether a task still needs work, is waiting for a human, or is
 *      terminal — and refuse to re-run Executor or Reviewer when it does not.
 *
 * It does NOT own: the reviewer, the gate verdict logic, the taskboard API, or
 * any scheduler. There is no polling loop and no daemon.
 *
 * Persistence mapping (dashi contract, verified in v0.1 and re-verified here):
 *   - task.status          <- Gate state (the durable state machine)
 *   - task.threadBinding   <- executor thread (native five-field binding)
 *   - comments             <- one JSON record per review attempt, plus the
 *                             reviewer binding on that comment
 */

import { STATES, VERDICTS, executeNativeReviewGate } from "./review-gate.mjs";

/** Prefix used to mark a comment as a machine-readable review-attempt record. */
export const ATTEMPT_PREFIX = "REVIEW_ATTEMPT ";

/** Gate states that mean "no further automatic work is allowed". */
export const TERMINAL_STATES = Object.freeze([
  STATES.IN_REVIEW,   // PASS already reached; only human acceptance remains
  STATES.DONE,
  STATES.BLOCKED,
]);

/**
 * Read the durable state of a task plus its attempt history.
 *
 * Returns `{ task, attempts, executorThreadId, resume }`. `resume.action` is one
 * of `run`, `await_human`, `blocked`, `done`.
 */
export async function readTaskState({ taskboard, taskId }) {
  const task = await taskboard.getTask(taskId);
  const comments = await taskboard.request(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
  const attempts = [];
  for (const comment of comments.comments ?? []) {
    const body = String(comment.body ?? "");
    if (!body.startsWith(ATTEMPT_PREFIX)) continue;
    try {
      attempts.push({
        ...JSON.parse(body.slice(ATTEMPT_PREFIX.length)),
        commentId: comment.id,
        reviewerBindingOnComment: comment.threadBinding?.threadId ?? null,
      });
    } catch {
      // A malformed record is reported, never silently repaired.
      attempts.push({ commentId: comment.id, malformed: true, raw: body.slice(0, 200) });
    }
  }
  attempts.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));

  const executorThreadId = task.threadBinding?.threadId ?? null;
  const lastAttempt = attempts.filter((a) => !a.malformed).at(-1) ?? null;

  let action;
  if (task.status === STATES.DONE) action = "done";
  else if (task.status === STATES.BLOCKED) action = "blocked";
  else if (task.status === STATES.IN_REVIEW) action = "await_human";
  else if (task.status === STATES.IN_PROGRESS) action = "run";
  else if (task.status === STATES.REJECTED) action = "run";
  else action = "run";

  return {
    task,
    attempts,
    executorThreadId,
    lastAttempt,
    resume: {
      action,
      reason: describeResume(action, task, lastAttempt),
      // A task that is already in review must never be re-executed automatically.
      mustNotRerunExecutor: action !== "run",
      mustNotRerunReviewer: action !== "run",
    },
  };
}

function describeResume(action, task, lastAttempt) {
  switch (action) {
    case "await_human":
      return `task is in_review (last verdict: ${lastAttempt?.verdict ?? "unknown"}); waiting for human acceptance`;
    case "done":
      return "task is done";
    case "blocked":
      return "task is blocked; requires human intervention";
    case "run":
      return `task is ${task.status}; the Gate may run`;
    default:
      return "unknown state";
  }
}

/**
 * Append one review attempt as a durable Taskboard comment.
 *
 * The reviewer thread binding rides on the comment, so the attempt — not just
 * the task — records which reviewer looked at it. Re-reading the task restores
 * the full attempt history.
 */
export async function persistReviewAttempt({ taskboard, taskId, binding, record }) {
  const body = `${ATTEMPT_PREFIX}${JSON.stringify(record)}`;
  const reviewerBinding = record.reviewerThreadId
    ? {
        threadId: record.reviewerThreadId,
        codexProjectId: binding.codexProjectId,
        codexProjectKind: binding.codexProjectKind,
        codexHostId: binding.codexHostId,
        workspacePath: binding.workspacePath,
      }
    : undefined;
  return taskboard.addComment(taskId, { body, binding: reviewerBinding });
}

/**
 * Run the Review Gate for a task, persisting every transition.
 *
 * `options.task` may be omitted: the durable Taskboard state is always read
 * first, so a resumed process uses the stored version rather than a stale one.
 */
export async function runTaskThroughGate({
  taskboard,
  taskId,
  executor,
  appServer,
  model,
  modelProvider = "custom",
  maxAttempts = 3,
  reviewTimeoutMs = 900_000,
  acceptanceCriteria = [],
  requiredChecks = [],
  reviewScope = [],
  reviewTarget = null,
}) {
  const state = await readTaskState({ taskboard, taskId });

  if (state.resume.action !== "run") {
    return {
      status: state.resume.action === "await_human" ? "READY_FOR_ACCEPTANCE" : state.resume.action.toUpperCase(),
      resumed: true,
      attemptedWork: false,
      resume: state.resume,
      task: state.task,
      attempts: state.attempts,
    };
  }

  const task = state.task;
  const result = await executeNativeReviewGate({
    taskId,
    task,
    executor,
    appServer,
    taskboard,
    model,
    modelProvider,
    maxAttempts,
    reviewTimeoutMs,
    acceptanceCriteria,
    requiredChecks,
    reviewScope,
    reviewTarget,
    onReviewAttempt: async (record) => {
      await persistReviewAttempt({ taskboard, taskId, binding: executor.binding, record });
    },
  });

  const finalTask = await taskboard.getTask(taskId);
  return {
    status: result.status,
    resumed: false,
    attemptedWork: true,
    gate: result,
    task: finalTask,
    attempts: (await readTaskState({ taskboard, taskId })).attempts,
  };
}

/**
 * Human acceptance. This is the only path to `done`.
 *
 * Kept explicit and separate so nothing in the automatic flow can reach it.
 */
export async function acceptTask({ taskboard, taskId, reason, binding }) {
  const state = await readTaskState({ taskboard, taskId });
  if (state.task.status !== STATES.IN_REVIEW) {
    throw new Error(
      `human acceptance requires the task to be in_review; current status is ${state.task.status}`,
    );
  }
  const lastVerdict = state.lastAttempt?.verdict ?? null;
  if (lastVerdict && lastVerdict !== VERDICTS.PASS) {
    throw new Error(`refusing to accept: last review verdict was ${lastVerdict}`);
  }
  await taskboard.addComment(taskId, {
    body: `Human acceptance recorded.${reason ? ` ${reason}` : ""}`,
    binding,
  });
  return taskboard.moveTask(taskId, STATES.DONE, state.task.version, binding);
}
