/**
 * For each candidate model, does the provider honour `turn/start.outputSchema`?
 *
 * Uses an unguessable schema so a model that merely produces well-shaped JSON
 * cannot be mistaken for one that is actually constrained. Records the raw
 * response for every model so the result is evidence, not a summary.
 *
 * One read-only turn per model. No files touched.
 */
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const cwd = process.env.FUSION_POC_CWD ?? process.cwd();
const models = (process.env.FUSION_POC_MODELS ?? "<your-model>").split(",").map((m) => m.trim()).filter(Boolean);
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 600_000);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["zeta_marker", "quux_verdict"],
  properties: {
    zeta_marker: { type: "integer" },
    quux_verdict: { type: "string", enum: ["alpha", "beta"] },
  },
};

const results = [];
for (const model of models) {
  const server = new AppServerStdio({ cwd, timeoutMs: 120_000 });
  const entry = { model };
  try {
    await server.start();
    const thread = await server.startThread({ cwd, model, modelProvider, sandbox: "read-only" });
    const threadId = thread?.thread?.id;
    const started = await server.startTurnWithSchema({
      threadId,
      message: "Respond using the required output format.",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: SCHEMA,
    });
    const completed = await server.waitForTurn({ threadId, turnId: started?.turn?.id, timeoutMs });
    const text = completed.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
    entry.turnStatus = completed.status;
    entry.turnError = completed.error;
    entry.parsed = completed.structuredOutput;
    entry.returnedKeys = completed.structuredOutput ? Object.keys(completed.structuredOutput) : null;
    entry.honouredSchema = Boolean(
      completed.structuredOutput
      && "zeta_marker" in completed.structuredOutput
      && ["alpha", "beta"].includes(completed.structuredOutput.quux_verdict),
    );
    entry.rawHead = text.slice(0, 160);
  } catch (error) {
    entry.error = String(error);
    entry.honouredSchema = false;
  } finally {
    await server.stop();
  }
  results.push(entry);
}

console.log(JSON.stringify({ cwd, modelProvider, results }, null, 2));
