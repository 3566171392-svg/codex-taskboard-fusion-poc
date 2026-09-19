/**
 * Decisive probe: does this provider actually enforce `turn/start.outputSchema`?
 *
 * Codex forwards the schema to the upstream Responses API as
 * `text.format = {type:"json_schema", strict:true, schema}` (see
 * codex-rs/app-server/tests/suite/v2/output_schema.rs). Whether that constrains
 * the model is then the provider's job, not Codex's.
 *
 * Method: the schema requires field names a model could not guess
 * (`zeta_marker`, `quux_verdict`). If the response contains those exact keys,
 * the schema reaches the model. If the response silently renames them, the
 * schema is being dropped or ignored somewhere upstream.
 *
 * One turn, read-only, no files touched.
 */
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const cwd = process.env.FUSION_POC_CWD ?? process.cwd();
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
if (!model) { console.error("Set FUSION_POC_MODEL."); process.exit(2); }

const UNGUESSABLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["zeta_marker", "quux_verdict"],
  properties: {
    zeta_marker: { type: "integer" },
    quux_verdict: { type: "string", enum: ["alpha", "beta"] },
  },
};

const server = new AppServerStdio({ cwd, timeoutMs: 300_000 });
const report = { cwd, model, modelProvider, expectedKeys: ["zeta_marker", "quux_verdict"] };

try {
  await server.start();
  const thread = await server.startThread({ cwd, model, modelProvider, sandbox: "read-only" });
  const threadId = thread?.thread?.id;

  const started = await server.startTurnWithSchema({
    threadId,
    message: "Respond to this request using the required output format.",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    outputSchema: UNGUESSABLE_SCHEMA,
  });
  const completed = await server.waitForTurn({ threadId, turnId: started?.turn?.id, timeoutMs: 300_000 });

  const text = completed.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
  report.turnStatus = completed.status;
  report.turnError = completed.error;
  report.rawText = text;
  report.parsed = completed.structuredOutput;
  report.returnedKeys = completed.structuredOutput ? Object.keys(completed.structuredOutput) : null;
  report.honouredSchema = Boolean(
    completed.structuredOutput
    && "zeta_marker" in completed.structuredOutput
    && "quux_verdict" in completed.structuredOutput
    && ["alpha", "beta"].includes(completed.structuredOutput.quux_verdict),
  );
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = (server.lastStderr ?? "").split("\n").slice(-3).join("\n");
  await server.stop();
  console.log(JSON.stringify(report, null, 2));
}
