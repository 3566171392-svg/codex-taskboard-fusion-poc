/**
 * Live smoke: does Codex's native review/start work the way the Gate needs?
 *
 * Confirms, on this machine's actual build:
 *   1. thread/start (read-only) -> a fresh reviewer thread
 *   2. review/start with delivery "inline" on that thread
 *   3. the review lifecycle items (enteredReviewMode / exitedReviewMode)
 *   4. the review body text, so the Gate's `VERDICT:` extraction can be checked
 *      against real output
 *
 * It also confirms the target shapes the Gate may use (`custom` carries the
 * review contract; `uncommittedChanges` reviews the working tree).
 *
 * Read-only: nothing in the workspace is modified.
 *
 * Env: FUSION_POC_CWD, FUSION_POC_MODEL, optional FUSION_POC_MODEL_PROVIDER.
 */
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const cwd = process.env.FUSION_POC_CWD ?? process.cwd();
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 600_000);
const targetType = process.env.FUSION_POC_REVIEW_TARGET ?? "custom";

if (!model) {
  console.error("Set FUSION_POC_MODEL first.");
  process.exit(2);
}

const reviewerInstruction = [
  "You are an independent reviewer on a separate read-only thread.",
  "Inspect the real workspace yourself; do not trust any summary.",
  `Workspace: ${cwd}`,
  "",
  "Report every defect you can substantiate from the actual files.",
  "End your final message with exactly one line:",
  "VERDICT: PASS",
  "or",
  "VERDICT: FAIL",
].join("\n");

const target = targetType === "uncommittedChanges"
  ? { type: "uncommittedChanges" }
  : { type: "custom", instructions: reviewerInstruction };

const server = new AppServerStdio({ cwd, timeoutMs: 120_000 });
const report = { cwd, model, modelProvider, targetType };

try {
  await server.start();

  const executor = await server.startThread({ cwd, model, modelProvider, sandbox: "read-only" });
  const executorThreadId = executor?.thread?.id ?? null;
  report.executorThreadId = executorThreadId;

  const reviewer = await server.startThread({ cwd, model, modelProvider, sandbox: "read-only" });
  const reviewerThreadId = reviewer?.thread?.id ?? null;
  if (!reviewerThreadId) throw new Error("reviewer thread/start returned no thread id");
  report.reviewerThreadId = reviewerThreadId;
  report.reviewerIsIndependent = reviewerThreadId !== executorThreadId;
  report.reviewerSandbox = reviewer.sandbox?.type ?? null;

  // The Gate must not be able to ask for detached delivery.
  let detachedRejected = null;
  try {
    await server.startReview({ threadId: reviewerThreadId, target, delivery: "detached" });
    detachedRejected = false;
  } catch (error) {
    detachedRejected = String(error).slice(0, 120);
  }
  report.detachedRefusedByAdapter = detachedRejected;

  const started = await server.startReview({ threadId: reviewerThreadId, target, delivery: "inline" });
  report.reviewThreadId = started?.reviewThreadId ?? null;
  report.reviewTurnId = started?.turn?.id ?? null;

  const completed = await server.waitForReview({
    threadId: reviewerThreadId, turnId: report.reviewTurnId, timeoutMs,
  });
  report.turnStatus = completed.status;
  report.turnError = completed.error ?? null;
  report.reviewMode = completed.reviewMode;
  report.reviewTextLength = completed.review?.length ?? 0;
  report.reviewTextTail = (completed.review ?? "").split(/\r?\n/).slice(-6).join("\n");
  report.itemTypes = completed.items.map((item) => item.type);
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = String(server.lastStderr ?? "").split("\n").slice(-3).join("\n");
  await server.stop();
  console.log(JSON.stringify(report, null, 2));
}
