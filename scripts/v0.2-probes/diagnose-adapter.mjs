/**
 * Two focused diagnoses of src/adapters/app-server-stdio.mjs on this machine.
 *
 * 1. Does `startThread` forward `historyMode`? (Detached review is refused on
 *    paginated threads, so silently dropping it makes detached permanently
 *    unreachable through this adapter.)
 *
 * 2. Does `waitForReview` still observe `turn/completed` after a realistic
 *    notification volume? The adapter keeps a 2000-entry ring buffer while
 *    `waitForReview` walks it with a monotonic cursor.
 *
 * Both probes talk to the real app-server or a local fake; nothing is patched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const cwd = process.env.FUSION_POC_CWD ?? process.cwd();
const model = process.env.FUSION_POC_MODEL ?? "<your-model>";
const report = {};

// ---------------------------------------------------------------- probe 1
{
  const client = new AppServerStdio({ cwd, timeoutMs: 120_000 });
  try {
    await client.start();
    const viaAdapter = await client.startThread({
      cwd, model, modelProvider: "custom", sandbox: "workspace-write", historyMode: "legacy",
    });
    const viaRaw = await client.request("thread/start", {
      cwd, model, modelProvider: "custom", sandbox: "workspace-write", historyMode: "legacy",
    });
    report.historyMode = {
      viaAdapter_startThread: viaAdapter.thread?.historyMode ?? null,
      viaRaw_request: viaRaw.thread?.historyMode ?? null,
      adapterDroppedIt: (viaAdapter.thread?.historyMode ?? null) !== "legacy"
        && (viaRaw.thread?.historyMode ?? null) === "legacy",
    };
  } catch (error) {
    report.historyMode = { error: String(error) };
  } finally {
    await client.stop();
  }
}

// ---------------------------------------------------------------- probe 2
{
  const fakePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fake-burst-server.cjs");
  const fake = `
const BURST = 2500;
process.stdin.setEncoding('utf8');
require('readline').createInterface({input:process.stdin}).on('line', line=>{
  const x = JSON.parse(line);
  const reply = (r)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:r})+'\\n');
  const note = (method,params)=>{ process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\\n'); };
  if (x.method === 'initialize') reply({ ok: true });
  else if (x.method === 'thread/start') reply({ thread: { id: 'th-1', historyMode: 'legacy' } });
  else if (x.method === 'review/start') {
    reply({ reviewThreadId: 'rev-1', turn: { id: 'rt-1', status: 'inProgress' } });
    // Realistic volume: a review turn emits far more than 2000 notifications.
    for (let i = 0; i < BURST; i += 1) note('item/reasoning/summaryTextDelta', { threadId: 'rev-1', turnId: 'rt-1', delta: 'x' });
    note('item/completed', { threadId: 'rev-1', turnId: 'rt-1', item: { id: 'rt-1', type: 'exitedReviewMode', review: '{"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9,"findings":[]}' } });
    note('turn/completed', { threadId: 'rev-1', turn: { id: 'rt-1', status: 'completed' } });
  }
});
`;
  await fs.writeFile(fakePath, fake);
  const client = new AppServerStdio({ executable: process.execPath, args: [fakePath] });
  const startedAt = Date.now();
  try {
    await client.start();
    await client.startThread({ cwd: process.cwd(), model: "test" });
    const started = await client.startReview({ threadId: "th-1", delivery: "detached", target: { type: "uncommittedChanges" } });
    const completed = await client.waitForReview({ turnId: started.turn.id, timeoutMs: 8_000 });
    report.burst = {
      resolved: true,
      elapsedMs: Date.now() - startedAt,
      reviewText: completed.reviewText ?? null,
      notificationsBuffered: client.notifications.length,
    };
  } catch (error) {
    report.burst = {
      resolved: false,
      elapsedMs: Date.now() - startedAt,
      error: String(error),
      notificationsBuffered: client.notifications.length,
      bufferedMethods: [...new Set(client.notifications.map((n) => n.method))],
      hasTurnCompletedInBuffer: client.notifications.some(
        (n) => n.method === "turn/completed" && n.params?.turn?.id === "rt-1",
      ),
    };
  } finally {
    await client.stop();
    await fs.rm(fakePath, { force: true });
  }
}

console.log(JSON.stringify(report, null, 2));
