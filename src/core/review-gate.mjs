/**
 * Codex-native Review Gate MVP.
 *
 * Flow:
 *
 *   Taskboard task
 *     -> in_review
 *     -> Executor thread A: implementation
 *     -> machine evidence (real tests, git state, workspace fingerprint)
 *     -> Reviewer thread B (fresh, read-only, same workspace)
 *          -> native `review/start` (inline, on B)
 *          -> review lifecycle: enteredReviewMode / exitedReviewMode / turn completed
 *     -> verdict extraction from the review body (`VERDICT: PASS|FAIL`)
 *     -> machine-evidence gate
 *     -> PASS  -> in_review, READY_FOR_ACCEPTANCE (human acceptance still required)
 *        FAIL  -> todo -> in_progress -> the SAME executor thread A repairs
 *                 -> new Reviewer thread C reviews again
 *        BLOCKED -> blocked
 *
 * The Gate never converts prose into a PASS. A verdict requires an explicit
 * marker, and a PASS additionally requires the machine checks to pass.
 *
 * `turn/start.outputSchema` is no longer part of the verdict contract. The
 * reviewer's verdict travels through Codex's own review machinery.
 */

import {
  VERDICT_MARKER,
  buildReviewInstruction,
  extractFindings,
  extractVerdict,
} from "./review-contract.mjs";

export const STATES = Object.freeze({
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  DONE: "done",
  REJECTED: "todo",
  BLOCKED: "blocked",
});

export const VERDICTS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED" });

const isReadOnly = (sandbox) => sandbox === "readOnly" || sandbox === "read-only";

const blocked = (reason, details = {}) => ({ verdict: VERDICTS.BLOCKED, reason, ...details });

/**
 * Layer C: the machine-evidence gate.
 *
 * Independent of the reviewer's opinion. Returns the first blocking problem, or
 * a FAIL when required verification failed, or null when everything is sound.
 *
 * `checks` mirrors the requirements listed for this MVP:
 *   reviewer thread distinct from executor, reviewer read-only, review turn
 *   completed normally, review lifecycle observed, workspace identity matched,
 *   required machine verification passed.
 */
export function checkMachineEvidence({
  executorThreadId,
  reviewerThreadId,
  reviewerSandbox,
  reviewTurnStatus,
  reviewTurnError,
  reviewMode,
  evidence = {},
  requireLifecycle = true,
}) {
  if (!reviewerThreadId) return blocked("reviewer thread was not created");
  if (reviewerThreadId === executorThreadId) {
    return blocked("reviewer thread is the executor thread; review is not independent");
  }
  if (!isReadOnly(reviewerSandbox)) {
    return blocked(`reviewer sandbox must be read-only, server reported ${reviewerSandbox ?? "none"}`);
  }
  if (reviewTurnStatus !== "completed") {
    return blocked(`review turn did not complete normally (status: ${reviewTurnStatus ?? "unknown"})`);
  }
  if (reviewTurnError) {
    return blocked(`review turn reported an error: ${JSON.stringify(reviewTurnError)}`);
  }
  if (requireLifecycle && (!reviewMode || reviewMode.entered < 1 || reviewMode.exited < 1)) {
    return blocked(
      "native review lifecycle was not observed " +
      `(enteredReviewMode: ${reviewMode?.entered ?? 0}, exitedReviewMode: ${reviewMode?.exited ?? 0})`,
    );
  }
  if (evidence.identityMatches === false) {
    return blocked("workspace identity did not match the executor binding");
  }
  if (evidence.allChecksPassed === false) {
    return {
      verdict: VERDICTS.FAIL,
      reason: "required machine verification failed",
      failureKind: "deterministic_verification",
      deterministicDetail: evidence.failedChecks ?? null,
    };
  }
  return null;
}

/**
 * Combine the three layers into the Gate verdict.
 *
 * Order matters: machine problems first (a broken review channel must not hide
 * failing tests), then the reviewer's explicit verdict, then the PASS guard.
 */
export function deriveReviewVerdict({
  verdict,
  machineFailure,
  evidence = {},
}) {
  // Layer C — machine evidence. Checked before the reviewer's opinion so that
  // failing tests always reach the executor instead of stalling as BLOCKED.
  if (machineFailure) return machineFailure;

  // Layer B — explicit verdict extraction.
  if (!verdict || !verdict.verdict) {
    return blocked(`reviewer did not emit an unambiguous verdict: ${verdict?.reason ?? "no verdict"}`);
  }
  if (verdict.verdict === "FAIL") {
    return {
      verdict: VERDICTS.FAIL,
      reason: "reviewer reported FAIL",
      failureKind: "review_findings",
    };
  }

  // Layer A — a PASS still has to survive the evidence gate above. Reaching this
  // point means both layers passed.
  if (evidence.identityMatches === false) {
    return blocked("workspace identity did not match the executor binding");
  }
  return {
    verdict: VERDICTS.PASS,
    reason: "independent native review reported PASS and machine evidence passed",
  };
}

function assertBinding(binding) {
  const missing = ["threadId", "workspacePath"].filter((key) => !binding?.[key]);
  if (missing.length > 0) {
    throw new Error(`executor binding must include ${missing.join(" and ")}`);
  }
}

/**
 * Create the fresh Reviewer thread and run one native review on it.
 *
 * The reviewer thread is always new (never the executor's, never reused between
 * attempts) and always read-only. The review itself uses Codex's native
 * `review/start` with inline delivery on that thread.
 */
export async function runNativeReview({
  appServer,
  executorBinding,
  task,
  acceptanceCriteria = [],
  evidence,
  model,
  modelProvider = "custom",
  reviewTarget = null,
  reviewScope = [],
  timeoutMs = 900_000,
}) {
  const thread = await appServer.startThread({
    cwd: executorBinding.workspacePath,
    model,
    modelProvider,
    sandbox: "read-only",
  });
  const reviewerThreadId = thread?.thread?.id ?? null;
  if (!reviewerThreadId) throw new Error("reviewer thread/start returned no thread id");
  if (reviewerThreadId === executorBinding.threadId) {
    throw new Error("reviewer thread must differ from the executor thread");
  }
  const sandbox = thread?.sandbox?.type ?? thread?.thread?.sandbox?.type ?? null;
  if (!isReadOnly(sandbox)) {
    throw new Error(`reviewer thread sandbox must be read-only, server reported ${sandbox ?? "none"}`);
  }

  // The review instruction travels through review/start's own `custom` target
  // rather than a separate turn, so the reviewer thread runs exactly one turn:
  // the Codex-native review. It never receives the executor's transcript.
  const instruction = buildReviewInstruction({
    task, acceptanceCriteria, evidence, workspacePath: executorBinding.workspacePath, reviewScope,
  });
  const target = reviewTarget ?? { type: "custom", instructions: instruction };
  const started = await appServer.startReview({
    threadId: reviewerThreadId,
    target,
    delivery: "inline",
  });
  const reviewTurnId = started?.turn?.id ?? null;
  if (!reviewTurnId) throw new Error("review/start returned no review turn id");

  const completed = await appServer.waitForReview({
    threadId: reviewerThreadId,
    turnId: reviewTurnId,
    timeoutMs,
  });

  return {
    reviewerThreadId,
    sandbox,
    reviewTurnId,
    status: completed.status,
    error: completed.error ?? null,
    reviewMode: completed.reviewMode,
    reviewText: completed.review ?? "",
  };
}

export async function executeNativeReviewGate({
  taskId,
  task,
  executor,
  appServer,
  taskboard,
  model,
  modelProvider = "custom",
  maxAttempts = 3,
  reviewTimeoutMs = 900_000,
  acceptanceCriteria = [],
  requiredChecks = [],
  evidenceProvider = null,
  reviewTarget = null,
  reviewScope = [],
  requireLifecycle = true,
  /**
   * Called once per review attempt with a durable record:
   * `{ attempt, executorThreadId, reviewerThreadId, verdict, reviewLifecycle,
   *    machineEvidence, at }`. The Gate owns the event; the caller decides how
   * to persist it. Used to keep attempt history in the Taskboard.
   */
  onReviewAttempt = null,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  assertBinding(executor.binding);

  const trace = [];
  const reviewerThreadIds = [];

  await taskboard.moveTask(taskId, STATES.IN_REVIEW, task.version, executor.binding);
  trace.push({ event: "task.in_review" });

  // Workspace state at the moment the executor claims it is done.
  const fingerprintBefore = evidenceProvider?.fingerprintWorkspace?.() ?? null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const freshTask = await taskboard.getTask(taskId);

    // ---- Layer C input: real machine evidence -----------------------------
    let evidence;
    try {
      evidence = evidenceProvider
        ? await evidenceProvider.collect({ task: freshTask, attempt, workspacePath: executor.binding.workspacePath })
        : await executor.collectHandoff({ task: freshTask, attempt });
    } catch (error) {
      trace.push({ event: "gate.blocked", attempt, reason: `evidence collection failed: ${String(error)}` });
      await taskboard.addComment(taskId, {
        body: `Review Gate BLOCKED (attempt ${attempt}): evidence collection failed: ${String(error)}`,
        binding: executor.binding,
      });
      await taskboard.moveTask(taskId, STATES.BLOCKED, (await taskboard.getTask(taskId)).version, executor.binding);
      return { status: VERDICTS.BLOCKED, attempt, trace, review: null, reviewerThreadIds };
    }

    if (evidence.identityMatches === false) {
      trace.push({ event: "gate.blocked", attempt, reason: "identity mismatch" });
      await taskboard.addComment(taskId, {
        body: `Review Gate BLOCKED (attempt ${attempt}): workspace identity mismatch`,
        binding: executor.binding,
      });
      await taskboard.moveTask(taskId, STATES.BLOCKED, (await taskboard.getTask(taskId)).version, executor.binding);
      return { status: VERDICTS.BLOCKED, attempt, trace, review: null, reviewerThreadIds };
    }

    // ---- Independent reviewer + native review -----------------------------
    let run;
    try {
      run = await runNativeReview({
        appServer, executorBinding: executor.binding, task: freshTask,
        acceptanceCriteria, evidence, model, modelProvider,
        reviewTarget, reviewScope, timeoutMs: reviewTimeoutMs,
      });
    } catch (error) {
      const historyLost = error?.code === "HISTORY_LOST";
      trace.push({ event: "gate.blocked", attempt, reason: String(error), historyLost });
      await taskboard.addComment(taskId, {
        body: `Review Gate BLOCKED (attempt ${attempt}): ${String(error)}`,
        binding: executor.binding,
      });
      await taskboard.moveTask(taskId, STATES.BLOCKED, (await taskboard.getTask(taskId)).version, executor.binding);
      return { status: VERDICTS.BLOCKED, attempt, trace, review: null, reviewerThreadIds, error: String(error) };
    }

    reviewerThreadIds.push(run.reviewerThreadId);

    // ---- Layer A: reviewer completion -------------------------------------
    const machineFailure = checkMachineEvidence({
      executorThreadId: executor.binding.threadId,
      reviewerThreadId: run.reviewerThreadId,
      reviewerSandbox: run.sandbox,
      reviewTurnStatus: run.status,
      reviewTurnError: run.error,
      reviewMode: run.reviewMode,
      evidence,
      requireLifecycle,
    });

    // ---- Layer B: verdict extraction --------------------------------------
    const verdict = extractVerdict(run.reviewText);
    const findings = extractFindings(run.reviewText);

    trace.push({
      event: "review.run",
      attempt,
      executorThreadId: executor.binding.threadId,
      reviewerThreadId: run.reviewerThreadId,
      reviewerIsIndependent: run.reviewerThreadId !== executor.binding.threadId,
      sandbox: run.sandbox,
      reviewTurnId: run.reviewTurnId,
      turnStatus: run.status,
      reviewMode: run.reviewMode,
      verdictMarker: verdict.marker,
      verdictReason: verdict.reason,
      checksPassed: evidence.allChecksPassed,
      gitDirty: evidence.git?.dirty ?? null,
      changedFiles: evidence.git?.changedFiles ?? null,
    });

    const derived = deriveReviewVerdict({ verdict, machineFailure, evidence });
    trace.push({ event: "gate.verdict", attempt, ...derived, reviewerThreadId: run.reviewerThreadId });

    // Durable attempt record. Persistence failures must not silently drop the
    // attempt, so the outcome is surfaced into the trace as well.
    if (onReviewAttempt) {
      const record = {
        attempt,
        executorThreadId: executor.binding.threadId,
        reviewerThreadId: run.reviewerThreadId,
        reviewTurnId: run.reviewTurnId,
        verdict: derived.verdict,
        verdictReason: derived.reason ?? null,
        failureKind: derived.failureKind ?? null,
        reviewLifecycle: run.reviewMode ?? null,
        machineEvidence: {
          allChecksPassed: evidence.allChecksPassed ?? null,
          failedChecks: evidence.failedChecks ?? [],
          fingerprintDigest: evidence.fingerprint?.digest ?? null,
          gitDirty: evidence.git?.dirty ?? null,
          changedFiles: evidence.git?.changedFiles ?? null,
        },
        at: new Date().toISOString(),
      };
      try {
        await onReviewAttempt(record);
        trace.push({ event: "attempt.recorded", attempt, verdict: record.verdict });
      } catch (error) {
        trace.push({ event: "attempt.persist_failed", attempt, error: String(error) });
      }
    }

    // ---- PASS: stop at human acceptance ----------------------------------
    if (derived.verdict === VERDICTS.PASS) {
      await taskboard.addComment(taskId, {
        body:
          `Independent native review PASS (attempt ${attempt}).\n` +
          `Reviewer thread: ${run.reviewerThreadId} (read-only, distinct from executor).\n` +
          `Machine evidence: ${evidence.checks.length} check(s) passed; workspace digest ${evidence.fingerprint?.digest?.slice(0, 12)}.\n` +
          "Ready for human acceptance.",
        binding: executor.binding,
      });
      trace.push({ event: "gate.pass", attempt, awaiting: "human_acceptance" });
      return {
        status: "READY_FOR_ACCEPTANCE",
        attempt,
        trace,
        review: { text: run.reviewText, findings },
        reviewerThreadIds,
        evidence,
      };
    }

    // ---- BLOCKED: stop and surface why ------------------------------------
    if (derived.verdict === VERDICTS.BLOCKED) {
      await taskboard.addComment(taskId, {
        body: `Review Gate BLOCKED (attempt ${attempt}): ${derived.reason}`,
        binding: executor.binding,
      });
      await taskboard.moveTask(taskId, STATES.BLOCKED, (await taskboard.getTask(taskId)).version, executor.binding);
      trace.push({ event: "gate.blocked", attempt, reason: derived.reason });
      return {
        status: VERDICTS.BLOCKED,
        attempt,
        trace,
        review: { text: run.reviewText, findings },
        reviewerThreadIds,
        evidence,
      };
    }

    // ---- FAIL: reject, same executor repairs, new reviewer next round ------
    const reason = findings || derived.reason;
    await taskboard.addComment(taskId, {
      body: `Independent native review FAIL (attempt ${attempt})\n${reason}`,
      binding: executor.binding,
    });
    await taskboard.moveTask(taskId, STATES.REJECTED, freshTask.version, executor.binding);
    trace.push({ event: "task.rejected", attempt, reason });

    if (attempt === maxAttempts) {
      await taskboard.moveTask(taskId, STATES.BLOCKED, (await taskboard.getTask(taskId)).version, executor.binding);
      trace.push({ event: "gate.blocked", attempt, reason: "max attempts reached" });
      return {
        status: VERDICTS.BLOCKED,
        attempt,
        trace,
        review: { text: run.reviewText, findings },
        reviewerThreadIds,
        evidence,
      };
    }

    const afterReject = await taskboard.getTask(taskId);
    await taskboard.moveTask(taskId, STATES.IN_PROGRESS, afterReject.version, executor.binding);
    trace.push({ event: "task.reopened", attempt, executorThreadId: executor.binding.threadId });

    // The SAME executor thread repairs. No new executor thread is created.
    await executor.repair({
      task: await taskboard.getTask(taskId),
      reviewerFindings: findings,
      reviewerVerdict: derived,
      attempt,
    });
    trace.push({ event: "executor.repaired", attempt, executorThreadId: executor.binding.threadId });

    const repaired = await taskboard.getTask(taskId);
    await taskboard.moveTask(taskId, STATES.IN_REVIEW, repaired.version, executor.binding);
    trace.push({ event: "task.repaired", attempt });
  }

  throw new Error("unreachable review gate state");
}
