/**
 * Real probe: does this machine's provider accept and honour
 * `turn/start.outputSchema`?
 *
 * The protocol declares `output_schema: Option<JsonValue>` — a free-form JSON
 * Schema constraining the final assistant message. Nothing here assumes a
 * field shape; every step records what the server actually returned.
 *
 * Steps:
 *   1. baseline turn WITHOUT outputSchema (does structured output need opt-in?)
 *   2. turn WITH a minimal outputSchema, checking where the JSON lands
 *   3. inspect turn items for a structured-output item vs plain agentMessage
 *
 * Read-only with respect to the workspace.
 */
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const cwd = process.env.FUSION_POC_CWD;
const model = process.env.FUSION_POC_MODEL ?? "<your-model>";
if (!cwd) { console.error("Set FUSION_POC_CWD."); process.exit(2); }

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "confidence_score", "priority", "code_location"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          confidence_score: { type: "number" },
          priority: { type: "integer" },
          code_location: {
            type: "object",
            additionalProperties: false,
            required: ["absolute_file_path", "start_line", "end_line"],
            properties: {
              absolute_file_path: { type: "string" },
              start_line: { type: "integer" },
              end_line: { type: "integer" },
            },
          },
        },
      },
    },
    overall_correctness: { type: "string", enum: ["patch is correct", "patch is incorrect"] },
    overall_explanation: { type: "string" },
    overall_confidence_score: { type: "number" },
  },
};

const server = new AppServerStdio({ cwd, timeoutMs: 600_000 });
const report = { cwd, model };

const turnSummary = (turn) => ({
  id: turn?.id ?? null,
  status: turn?.status ?? null,
  error: turn?.error ?? null,
  itemsView: turn?.itemsView ?? null,
  itemTypes: (turn?.items ?? []).map((i) => i.type),
  agentMessages: (turn?.items ?? []).filter((i) => i.type === "agentMessage").map((i) => i.text),
});

try {
  await server.start();

  // ---- Phase 1: no outputSchema -----------------------------------------
  {
    const t = await server.startThread({ cwd, model, modelProvider: "custom", sandbox: "read-only" });
    const threadId = t.thread?.id;
    const started = await server.startTurn({
      threadId,
      message: 'Reply with exactly this JSON object and nothing else: {"overall_correctness":"patch is correct","overall_explanation":"probe","overall_confidence_score":0.5,"findings":[]}',
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const completed = await server.waitForTurn({ threadId, turnId: started.turn?.id });
    report.phase1_noSchema = { threadId, ...turnSummary(completed) };
  }

  // ---- Phase 2: with outputSchema ---------------------------------------
  {
    const t = await server.startThread({ cwd, model, modelProvider: "custom", sandbox: "read-only" });
    const threadId = t.thread?.id;
    let started;
    let schemaError = null;
    try {
      started = await server.startTurnWithSchema({
        threadId,
        message: "Review nothing. Return an empty findings array and say the patch is correct.",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: REVIEW_SCHEMA,
      });
    } catch (error) {
      schemaError = String(error);
    }
    report.phase2_withSchema = { threadId, schemaError, startTurnRaw: started ? turnSummary(started.turn) : null };
    if (!schemaError && started?.turn?.id) {
      const completed = await server.waitForTurn({ threadId, turnId: started.turn.id });
      const summary = turnSummary(completed);
      report.phase2_withSchema.completed = summary;
      const text = summary.agentMessages[0] ?? null;
      report.phase2_withSchema.agentMessageParses = (() => {
        if (typeof text !== "string") return null;
        try { const v = JSON.parse(text); return typeof v === "object" && v !== null; } catch { return false; }
      })();
      report.phase2_withSchema.agentMessageIsJson = typeof text === "string" ? /^\s*\{/.test(text) : null;
    }
  }
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = (server.lastStderr ?? "").split("\n").slice(-4).join("\n");
  await server.stop();
  console.log(JSON.stringify(report, null, 2));
}
