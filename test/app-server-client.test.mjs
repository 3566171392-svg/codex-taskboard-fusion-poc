import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { AppServerStdio, parseStructuredOutput } from "../src/adapters/app-server-stdio.mjs";
import { toFilesystemPath } from "../src/core/paths.mjs";

/**
 * Records every request so tests can assert on what actually reached the wire.
 */
const fakeServer = `
const requests = [];
process.stdin.setEncoding('utf8');
require('readline').createInterface({input:process.stdin}).on('line', line=>{
  const x = JSON.parse(line);
  const reply = (r)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:r})+'\\n');
  const note = (method,params)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\\n');
  if (x.method === 'initialize') reply({ ok: true });
  else if (x.method === 'initialized') {}
  else if (x.method === 'thread/start') { requests.push({method:x.method,params:x.params}); reply({ thread: { id: 'th-1', historyMode: x.params.historyMode ?? 'paginated' }, sandbox: { type: 'readOnly' } }); }
  else if (x.method === 'turn/start') {
    requests.push({method:x.method,params:x.params});
    const id = 'turn-' + requests.filter(r=>r.method==='turn/start').length;
    reply({ turn: { id, status: 'inProgress' } });
    note('turn/started', { threadId: x.params.threadId, turn: { id } });
    note('item/completed', { threadId: x.params.threadId, turnId: id, item: { type: 'agentMessage', id: 'm1', text: JSON.stringify({findings:[],overall_correctness:'patch is correct',overall_explanation:'ok',overall_confidence_score:0.9}) } });
    note('turn/completed', { threadId: x.params.threadId, turn: { id, status: 'completed', items: [{type:'agentMessage',id:'m1',text:JSON.stringify({findings:[],overall_correctness:'patch is correct',overall_explanation:'ok',overall_confidence_score:0.9})}] } });
  }
  else if (x.method === '_dump') reply(requests);
});
`;

async function withFakeServer(run) {
  const url = new URL("./fake-app-server.cjs", import.meta.url);
  await fs.writeFile(url, fakeServer);
  // Windows regression: the path must come from the URL conversion helper.
  const scriptPath = toFilesystemPath(url);
  assert.ok(!/^[\\/][A-Za-z]:/.test(scriptPath), `URL-shaped path leaked: ${scriptPath}`);
  const client = new AppServerStdio({ executable: process.execPath, args: [scriptPath] });
  try {
    await client.start();
    return await run(client);
  } finally {
    await client.stop();
    await fs.rm(url, { force: true });
  }
}

test("App Server adapter speaks JSON-RPC over stdio", async () => {
  await withFakeServer(async (client) => {
    const thread = await client.startThread({ cwd: process.cwd(), model: "test" });
    assert.equal(thread.thread.id, "th-1");
    const turn = await client.startTurn({ threadId: "th-1", message: "hello" });
    assert.equal(turn.turn.id, "turn-1");
  });
});

/**
 * Defect 2 regression: `historyMode` used to be dropped by the adapter, so the
 * server always saw the default. It must now arrive exactly as supplied.
 */
test("startThread forwards historyMode verbatim", async () => {
  await withFakeServer(async (client) => {
    const legacy = await client.startThread({ cwd: process.cwd(), model: "test", historyMode: "legacy" });
    assert.equal(legacy.thread.historyMode, "legacy");
    const paginated = await client.startThread({ cwd: process.cwd(), model: "test", historyMode: "paginated" });
    assert.equal(paginated.thread.historyMode, "paginated");
    const omitted = await client.startThread({ cwd: process.cwd(), model: "test" });
    assert.equal(omitted.thread.historyMode, "paginated", "omitted historyMode keeps server default");
  });
});

test("startThread forwards arbitrary supported parameters and rejects unknown ones", async () => {
  await withFakeServer(async (client) => {
    await client.startThread({
      cwd: process.cwd(), model: "test", modelProvider: "custom",
      sandbox: "read-only", historyMode: "legacy", approvalPolicy: "never",
    });
    await assert.rejects(
      () => client.startThread({ cwd: process.cwd(), model: "test", notARealParameter: true }),
      /unsupported parameter/i,
    );
  });
});

test("turn/start forwards outputSchema untouched", async () => {
  await withFakeServer(async (client) => {
    const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const started = await client.startTurnWithSchema({
      threadId: "th-1", message: "review", outputSchema: schema,
    });
    assert.equal(started.turn.id, "turn-1");
    const completed = await client.waitForTurn({ threadId: "th-1", turnId: started.turn.id });
    assert.equal(completed.status, "completed");
    assert.equal(completed.structuredOutput.overall_correctness, "patch is correct");
  });
});

test("waitForTurn surfaces a real turn/completed rather than the queued response", async () => {
  await withFakeServer(async (client) => {
    const started = await client.startTurn({ threadId: "th-1", message: "hello" });
    assert.equal(started.turn.status, "inProgress");
    const completed = await client.waitForTurn({ threadId: "th-1", turnId: started.turn.id });
    assert.equal(completed.status, "completed");
    assert.equal(completed.items.at(-1).type, "agentMessage");
  });
});

test("parseStructuredOutput never invents an object from prose", () => {
  assert.equal(parseStructuredOutput("Looks good to me."), null);
  assert.deepEqual(parseStructuredOutput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseStructuredOutput('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseStructuredOutput("[1,2]"), null);
});

/**
 * Defect 3 regression, on the real adapter.
 *
 * A live review turn emitted 70,383 notifications while the bounded log kept
 * only the newest few thousand. The old cursor silently skipped its own
 * `turn/completed` and the wait timed out. The fake server below emits a
 * comparable burst in one burst, then completes the turn.
 */
const burstServer = `
const BURST = 70000;
process.stdin.setEncoding('utf8');
require('readline').createInterface({input:process.stdin}).on('line', line=>{
  const x = JSON.parse(line);
  const reply = (r)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:r})+'\\n');
  const note = (method,params)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\\n');
  if (x.method === 'initialize') reply({ ok: true });
  else if (x.method === 'thread/start') reply({ thread: { id: 'th-1' } });
  else if (x.method === 'turn/start') {
    reply({ turn: { id: 'rt-1', status: 'inProgress' } });
    for (let i = 0; i < BURST; i += 1) {
      note('item/reasoning/summaryTextDelta', { threadId: x.params.threadId, turnId: 'rt-1', delta: 'x' });
    }
    note('turn/completed', { threadId: x.params.threadId, turn: { id: 'rt-1', status: 'completed', items: [
      { type: 'agentMessage', id: 'm1', text: JSON.stringify({findings:[],overall_correctness:'patch is correct',overall_explanation:'ok',overall_confidence_score:0.9}) },
    ] } });
  }
});
`;

test("a turn completing after a 70k-notification burst is still observed", async () => {
  const url = new URL("./fake-burst-server.cjs", import.meta.url);
  await fs.writeFile(url, burstServer);
  const client = new AppServerStdio({ executable: process.execPath, args: [toFilesystemPath(url)] });
  try {
    await client.start();
    const started = await client.startTurn({ threadId: "th-1", message: "review" });
    const completed = await client.waitForTurn({ threadId: "th-1", turnId: started.turn.id, timeoutMs: 30_000 });
    assert.equal(completed.status, "completed");
    assert.equal(completed.structuredOutput.overall_correctness, "patch is correct");
    assert.ok(client.log.lastSeq > 70_000, `expected the burst to be ingested, saw ${client.log.lastSeq}`);
    assert.ok(client.log.droppedCount > 0, "expected eviction to have happened");
  } finally {
    await client.stop();
    await fs.rm(url, { force: true });
  }
});

test("a late reader is told the history is gone instead of resuming wrongly", async () => {
  await withFakeServer(async (client) => {
    const started = await client.startTurn({ threadId: "th-1", message: "hello" });
    await client.waitForTurn({ threadId: "th-1", turnId: started.turn.id });
    // The client kept up, so the cursor it finished at is still readable.
    const fromStart = client.readNotificationsFrom(1);
    assert.ok(fromStart.length > 0);
    assert.throws(() => client.readNotificationsFrom(0), /cursor must be a positive integer/);
  });
});
