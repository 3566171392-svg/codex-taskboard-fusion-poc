/**
 * Deterministically reproduce the `waitForReview` failure seen in the real run.
 *
 * `waitForReview` walks `this.notifications` with a monotonically increasing
 * index, while `#handleLine` caps that array at 2000 entries and shifts old
 * ones out. Once the array shifts, the index no longer refers to the same
 * entry, so entries between polls are skipped and the cursor can run past the
 * live head. The fake server below emits a realistic volume spread over time
 * (a real review turn produced 70,383 notifications in the live run) and then
 * finishes normally.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fakePath = path.join(dir, "..", "test", "fake-slow-burst-server.cjs");

const fake = `
const CHUNKS = 60;
const PER_CHUNK = 200;          // 12,000 notifications total
process.stdin.setEncoding('utf8');
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
require('readline').createInterface({input:process.stdin}).on('line', async (line)=>{
  const x = JSON.parse(line);
  const reply = (r)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:r})+'\\n');
  const note = (method,params)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\\n');
  if (x.method === 'initialize') reply({ ok: true });
  else if (x.method === 'thread/start') reply({ thread: { id: 'th-1', historyMode: 'legacy' } });
  else if (x.method === 'review/start') {
    reply({ reviewThreadId: 'rev-1', turn: { id: 'rt-1', status: 'inProgress' } });
    for (let c = 0; c < CHUNKS; c += 1) {
      for (let i = 0; i < PER_CHUNK; i += 1) {
        note('item/reasoning/summaryTextDelta', { threadId: 'rev-1', turnId: 'rt-1', delta: 'x' });
      }
      await sleep(15);
    }
    note('item/completed', { threadId: 'rev-1', turnId: 'rt-1', item: { id: 'rt-1', type: 'exitedReviewMode', review: '{"overall_correctness":"patch is correct","findings":[]}' } });
    note('turn/completed', { threadId: 'rev-1', turn: { id: 'rt-1', status: 'completed' } });
  }
});
`;

await fs.writeFile(fakePath, fake);
const client = new AppServerStdio({ executable: process.execPath, args: [fakePath] });
const report = {};
try {
  await client.start();
  await client.startThread({ cwd: process.cwd(), model: "test" });
  const started = await client.startReview({
    threadId: "th-1", delivery: "detached", target: { type: "uncommittedChanges" },
  });
  const began = Date.now();
  try {
    const completed = await client.waitForReview({ turnId: started.turn.id, timeoutMs: 20_000 });
    report.outcome = "resolved";
    report.elapsedMs = Date.now() - began;
    report.reviewText = completed.reviewText ?? null;
  } catch (error) {
    report.outcome = "timed-out";
    report.elapsedMs = Date.now() - began;
    report.error = String(error);
  }
  report.bufferLength = client.notifications.length;
  report.turnCompletedStillInBuffer = client.notifications.some(
    (n) => n.method === "turn/completed" && n.params?.turn?.id === "rt-1",
  );
  report.exitedReviewModeStillInBuffer = client.notifications.some(
    (n) => n.params?.item?.type === "exitedReviewMode",
  );
} finally {
  await client.stop();
  await fs.rm(fakePath, { force: true });
}
console.log(JSON.stringify(report, null, 2));
