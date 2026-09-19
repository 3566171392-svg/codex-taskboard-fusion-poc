/**
 * Real structured-reviewer smoke.
 *
 * Creates an independent read-only Reviewer thread, runs one turn constrained
 * by the review contract (`turn/start.outputSchema`), and reports whether the
 * provider actually honours it. Nothing is parsed out of prose: if the response
 * does not satisfy the contract the result is BLOCKED.
 *
 * Modes:
 *   --review    ask for a real review of the workspace (default)
 *   --empty     ask for a trivially clean review; isolates provider/schema
 *               capability from review quality
 */
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";
import { REVIEW_OUTPUT_SCHEMA, validateReviewOutput } from "../src/core/review-contract.mjs";

const cwd = process.env.FUSION_POC_CWD ?? process.cwd();
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 600_000);
const mode = process.argv.includes("--empty") ? "empty" : "review";

if (!model) {
  console.error("Set FUSION_POC_MODEL before running.");
  process.exit(2);
}

const instruction = mode === "empty"
  ? [
      "This is a capability probe, not a code review.",
      "Return an empty findings array, overall_correctness set to \"patch is correct\",",
      "an explanatory sentence, and a confidence score.",
    ].join("\n")
  : [
      "You are an independent reviewer on a separate read-only thread.",
      "Do not modify files, create commits, or change any state.",
      `Workspace: ${cwd}`,
      "Inspect the real files and report every defect you can substantiate.",
      'Set overall_correctness to "patch is correct" only when you find no real defect.',
    ].join("\n");

const server = new AppServerStdio({ cwd, timeoutMs: 120_000 });
const report = { cwd, model, modelProvider, mode, codexHome: process.env.CODEX_HOME ?? null };

try {
  await server.start();

  const executor = await server.startThread({ cwd, model, modelProvider, sandbox: "read-only" });
  const executorThreadId = executor?.thread?.id ?? null;

  const reviewer = await server.startThread({ cwd, model, modelProvider, sandbox: "read-only" });
  const reviewerThreadId = reviewer?.thread?.id ?? null;
  if (!reviewerThreadId) throw new Error("reviewer thread/start returned no thread id");

  report.executorThreadId = executorThreadId;
  report.reviewerThreadId = reviewerThreadId;
  report.reviewerIsIndependent = reviewerThreadId !== executorThreadId;
  report.reviewerSandbox = reviewer.sandbox?.type ?? null;

  const started = await server.startTurnWithSchema({
    threadId: reviewerThreadId,
    message: instruction,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    outputSchema: REVIEW_OUTPUT_SCHEMA,
  });
  report.reviewTurnId = started?.turn?.id ?? null;

  const completed = await server.waitForTurn({ threadId: reviewerThreadId, turnId: report.reviewTurnId, timeoutMs });
  report.turnStatus = completed.status;
  report.turnError = completed.error;
  report.itemTypes = completed.items.map((item) => item.type);

  const structured = completed.structuredOutput;
  const validation = structured ? validateReviewOutput(structured) : { valid: false, errors: ["no structured output"] };
  report.structured = structured;
  report.validation = validation;
  report.verdict = validation.valid
    ? (structured.overall_correctness === "patch is correct" && structured.findings.length === 0 ? "PASS" : "FAIL")
    : "BLOCKED";

  const agentText = completed.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
  report.agentMessageIsJson = /^\s*\{/.test(agentText);
  report.agentMessageHead = agentText.slice(0, 400);
} catch (error) {
  report.error = String(error);
  report.verdict = report.verdict ?? "BLOCKED";
} finally {
  report.stderrTail = (server.lastStderr ?? "").split("\n").slice(-3).join("\n");
  await server.stop();
}

console.log(JSON.stringify(report, null, 2));
