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
  STATES.CANCELED,
]);

/**
 * The only statuses the Gate is allowed to start work from.
 *
 * `todo` is claimable and `in_progress`/`todo` (rejected) mean work is already
 * under way on this task's binding. Everything else must fail closed:
 *
 *   backlog   dashi's own rule is that backlog is **not approved for
 *             execution** — an assignee alone is not authorization. Treating it
 *             as runnable would let the Gate start unapproved work.
 *   canceled  the task will not continue; running it would resurrect it.
 *   blocked   requires human intervention.
 *   in_review PASS already reached; only human acceptance remains.
 *   done      terminal.
 *
 * Unknown statuses are deliberately *not* runnable: a status this module does
 * not understand is a reason to stop, never a reason to start.
 */
export const RUNNABLE_STATES = Object.freeze([
  STATES.TODO,
  STATES.IN_PROGRESS,
  STATES.REJECTED,   // === "todo": rejected by review and awaiting repair
]);

/**
 * Read the durable state of a task plus its attempt history.
 *
 * Returns `{ task, attempts, executorThreadId, resume }`. `resume.action` is one
 * of `run`, `await_human`, `blocked`, `done`, `canceled`, `not_approved`.
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

  const action = resolveResumeAction(task.status);

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

/**
 * Map a durable task status to what the orchestrator may do on resume.
 *
 * Fail closed: only `RUNNABLE_STATES` may run. The previous implementation ended
 * with `else action = "run"`, so `backlog`, `canceled` and any status this
 * module did not know about all fell through to "start executing".
 */
export function resolveResumeAction(status) {
  if (RUNNABLE_STATES.includes(status)) return "run";
  if (status === STATES.IN_REVIEW) return "await_human";
  if (status === STATES.DONE) return "done";
  if (status === STATES.BLOCKED) return "blocked";
  if (status === STATES.CANCELED) return "canceled";
  if (status === STATES.BACKLOG) return "not_approved";
  // An unrecognized status is a stop condition, never an invitation to run.
  return "unknown_status";
}

function describeResume(action, task, lastAttempt) {
  switch (action) {
    case "await_human":
      return `task is in_review (last verdict: ${lastAttempt?.verdict ?? "unknown"}); waiting for human acceptance`;
    case "done":
      return "task is done";
    case "blocked":
      return "task is blocked; requires human intervention";
    case "canceled":
      return "task is canceled; it will not continue";
    case "not_approved":
      return "task is in backlog, which is not approved for execution; a human must approve it first";
    case "unknown_status":
      return `task status "${task.status}" is not recognized; refusing to start work on it`;
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
  /**
   * Resume the executor thread before doing any work. Default on: a restarted
   * Fusion process must reattach to the thread the task is bound to rather than
   * let the caller hand it a fresh one.
   */
  resumeExecutor = true,
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

  // ---- reattach to the bound executor thread -----------------------------
  //
  // Fusion stores only `task -> executorThreadId`. It does not replay a
  // transcript and does not rebuild Codex context; `thread/resume` rejoins the
  // thread and the conversation history stays where it lives — with Codex.
  //
  // Only a *restart* resumes. A first run has no durable attempt history and its
  // executor thread was just created by the caller, so there is nothing to
  // rejoin — and attempting to resume a thread that has not run a turn yet fails
  // with `-32600 no rollout found`, which would turn every first run into
  // BLOCKED. `state.attempts` is what distinguishes the two cases.
  const attemptsUsed = state.attempts.filter((a) => !a.malformed).length;
  const isRestart = attemptsUsed > 0;
  const resumeResult = await resumeExecutorThread({
    appServer,
    state,
    executor,
    enabled: resumeExecutor && isRestart,
    model,
    modelProvider,
  });
  if (resumeResult.blocked) {
    await taskboard.addComment(taskId, {
      body: `Review Gate BLOCKED: could not resume the executor thread.\n${resumeResult.reason}`,
      binding: executor.binding,
    });
    await taskboard.moveTask(taskId, STATES.BLOCKED, state.task.version, executor.binding);
    return {
      status: VERDICTS.BLOCKED,
      resumed: true,
      attemptedWork: false,
      resumeAttempt: resumeResult,
      task: await taskboard.getTask(taskId),
      attempts: state.attempts,
    };
  }

  const task = state.task;
  // Continue the durable attempt sequence. A restart must not hand the task a
  // fresh budget of attempts, and the Taskboard must not end up with two records
  // both numbered `attempt: 1`.
  const firstAttempt = attemptsUsed + 1;

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
    firstAttempt,
    onReviewAttempt: async (record) => {
      await persistReviewAttempt({ taskboard, taskId, binding: executor.binding, record });
    },
  });

  const finalTask = await taskboard.getTask(taskId);
  return {
    status: result.status,
    resumed: false,
    attemptedWork: true,
    resumeAttempt: resumeResult,
    gate: result,
    task: finalTask,
    attempts: (await readTaskState({ taskboard, taskId })).attempts,
  };
}

/**
 * Reattach the caller's executor to the thread the task is bound to.
 *
 * Guarantees the caller cannot silently swap in a new executor thread:
 *
 *   1. the task must already carry an `executorThreadId`; otherwise this is a
 *      brand-new task and the caller's binding is authoritative,
 *   2. if the caller's binding names a *different* thread than the task does,
 *      that is a conflict, not a resume — it means work would continue on the
 *      wrong conversation, so it is refused,
 *   3. the App Server must confirm the thread still exists,
 *   4. the caller's binding is rewritten to the durable thread id, so any later
 *      `thread/start`-style behaviour cannot drift away from it.
 *
 * Returns `{ blocked: false, ... }` on success or `{ blocked: true, reason }`.
 */
export async function resumeExecutorThread({
  appServer,
  state,
  executor,
  enabled = true,
  model,
  modelProvider = "custom",
} = {}) {
  const durableThreadId = state?.executorThreadId ?? null;
  const bindingThreadId = executor?.binding?.threadId ?? null;

  // Nothing on the board yet: a first run, where the caller's thread is the
  // thing that will be persisted. There is nothing to rejoin.
  if (!durableThreadId) {
    return {
      blocked: false,
      resumed: false,
      reason: "task carries no executor binding yet; this is a first run",
      executorThreadId: bindingThreadId,
      threadIdBefore: bindingThreadId,
      threadIdAfter: bindingThreadId,
      threadIdUnchanged: bindingThreadId === bindingThreadId,
    };
  }

  if (bindingThreadId && bindingThreadId !== durableThreadId) {
    return {
      blocked: true,
      reason:
        `executor binding conflict: the task is bound to ${durableThreadId} ` +
        `but the executor presented ${bindingThreadId}. Refusing to continue work on a ` +
        "different thread than the one the task is bound to.",
      durableThreadId,
      bindingThreadId,
    };
  }

  if (!enabled) {
    return {
      blocked: false,
      resumed: false,
      reason: "resume disabled by caller",
      executorThreadId: durableThreadId,
      threadIdBefore: bindingThreadId,
      threadIdAfter: bindingThreadId ?? durableThreadId,
      threadIdUnchanged: (bindingThreadId ?? durableThreadId) === durableThreadId,
    };
  }

  if (!appServer?.resumeThread) {
    return {
      blocked: true,
      reason: "no app server capable of thread/resume was supplied",
      durableThreadId,
    };
  }

  try {
    await appServer.resumeThread({
      threadId: durableThreadId,
      model,
      modelProvider,
      sandbox: "workspace-write",
    });
  } catch (error) {
    return {
      blocked: true,
      reason: `thread/resume failed for ${durableThreadId}: ${String(error)}`,
      durableThreadId,
    };
  }

  // The durable id wins. The caller keeps using the same thread object it
  // already had, but it can no longer point at a different thread.
  const before = executor.binding.threadId;
  executor.binding.threadId = durableThreadId;
  const after = executor.binding.threadId;
  return {
    blocked: false,
    resumed: true,
    reason: `resumed executor thread ${durableThreadId}`,
    executorThreadId: durableThreadId,
    // Reported, not asserted: for a normal restart `before` already equals the
    // durable id, so this is true. It is false only when the caller presented no
    // thread at all, which the trace should show rather than hide.
    threadIdBefore: before,
    threadIdAfter: after,
    threadIdUnchanged: before === after,
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
