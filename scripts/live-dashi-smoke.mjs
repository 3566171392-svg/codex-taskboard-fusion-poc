/**
 * Minimal smoke against a REAL running dashi instance.
 *
 * Verifies, with the POC's own TaskboardHttp adapter, the contract pieces the
 * Gate needs before anything is wired together:
 *
 *   1. create a task
 *   2. read it back
 *   3. move it (versioned) with the executor's native thread binding
 *   4. attach the reviewer thread as a bound comment (attempt record)
 *   5. read back and confirm both thread ids persisted
 *
 * It also probes which persistence surfaces the running build actually offers,
 * so the Gate's attempt recording is built on a verified contract rather than
 * an assumed one.
 *
 * Env: FUSION_POC_TASKBOARD_URL, FUSION_POC_PROJECT_ID, FUSION_POC_CWD.
 */
import { TaskboardHttp } from "../src/adapters/taskboard-http.mjs";

const baseUrl = process.env.FUSION_POC_TASKBOARD_URL;
const projectId = process.env.FUSION_POC_PROJECT_ID ?? "fusion-gate";
const workspacePath = process.env.FUSION_POC_CWD ?? "D:\\poc\\gate-demo";

if (!baseUrl) {
  console.error("Set FUSION_POC_TASKBOARD_URL (e.g. http://127.0.0.1:<taskboard-port>).");
  process.exit(2);
}

const board = new TaskboardHttp({ baseUrl });
const report = { baseUrl, projectId, workspacePath, steps: [] };

const step = (name, data = {}) => { report.steps.push({ name, ...data }); return data; };

// Reachability first: never claim a connection that was not exercised.
try {
  const meta = await board.request("/api/meta");
  step("meta", { ok: true, capabilities: meta?.capabilities ?? null });
} catch (error) {
  step("meta", { ok: false, error: String(error), status: error.status ?? null });
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

// ---- project ------------------------------------------------------------
let project = null;
try {
  const created = await board.request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ id: projectId, name: "Fusion Gate", workspacePath }),
  });
  project = created.project;
  step("project.create", { id: project.id, workspacePath: project.workspacePath });
} catch (error) {
  const detail = error.body?.error?.code ?? null;
  step("project.create", { status: error.status, code: detail, note: "already exists is acceptable" });
}

// ---- task ---------------------------------------------------------------
const created = await board.request("/api/tasks", {
  method: "POST",
  body: JSON.stringify({
    projectId,
    title: "Review Gate persistence smoke",
    description: "Verifies the Gate's persistence surfaces against a real dashi instance.",
    status: "todo",
    priority: "medium",
  }),
});
const taskId = created.task.id;
step("task.create", { taskId, identifier: created.task.identifier, status: created.task.status, version: created.task.version });

const read = await board.getTask(taskId);
step("task.read", { status: read.status, version: read.version, threadBinding: read.threadBinding ?? null });

// ---- executor binding ---------------------------------------------------
const executorBinding = {
  threadId: process.env.FUSION_POC_EXECUTOR_THREAD_ID ?? "smoke-executor-thread",
  codexProjectId: projectId,
  codexProjectKind: "local",
  codexHostId: "local",
  workspacePath,
};
const moved = await board.moveTask(taskId, "in_progress", read.version, executorBinding);
step("task.move", {
  status: moved.status,
  version: moved.version,
  threadBinding: moved.threadBinding ?? null,
  executorBindingPersisted: moved.threadBinding?.threadId === executorBinding.threadId,
});

// ---- attempt record: reviewer thread as a bound comment ------------------
const reviewerThreadId = process.env.FUSION_POC_REVIEWER_THREAD_ID ?? "smoke-reviewer-thread";
const attemptRecord = {
  attempt: 1,
  executorThreadId: executorBinding.threadId,
  reviewerThreadId,
  verdict: "FAIL",
  reviewLifecycle: { entered: 1, exited: 1 },
  machineEvidence: { allChecksPassed: false },
  at: new Date().toISOString(),
};
const comment = await board.addComment(taskId, {
  body: `REVIEW_ATTEMPT ${JSON.stringify(attemptRecord)}`,
  binding: {
    threadId: reviewerThreadId,
    codexProjectId: projectId,
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  },
});
step("attempt.comment", {
  commentId: comment.id,
  commentVersion: comment.version,
  threadBinding: comment.threadBinding ?? null,
});

// ---- read back: both ids recoverable? -----------------------------------
const reread = await board.getTask(taskId);
const comments = await board.request(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
const recovered = (comments.comments ?? []).find((c) => String(c.body).startsWith("REVIEW_ATTEMPT"));
let parsedAttempt = null;
try { parsedAttempt = JSON.parse(String(recovered?.body ?? "").replace(/^REVIEW_ATTEMPT\s*/, "")); } catch { /* not json */ }

step("task.reread", {
  status: reread.status,
  version: reread.version,
  executorThreadId: reread.threadBinding?.threadId ?? null,
  commentCount: (comments.comments ?? []).length,
  attemptRecovered: parsedAttempt,
  attemptRecoveredFromComment: parsedAttempt !== null,
  reviewerBindingOnComment: recovered?.threadBinding?.threadId ?? null,
});

console.log(JSON.stringify(report, null, 2));
