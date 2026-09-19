import assert from "node:assert/strict";
import test from "node:test";
import { HistoryLostError, NotificationLog } from "../src/core/notification-log.mjs";

test("assigns monotonic sequences and serves events from a cursor", () => {
  const log = new NotificationLog({ capacity: 10 });
  assert.equal(log.append("a"), 1);
  assert.equal(log.append("b"), 2);
  assert.equal(log.append("c"), 3);
  assert.deepEqual(log.readFrom(1).map((e) => e.value), ["a", "b", "c"]);
  assert.deepEqual(log.readFrom(3).map((e) => e.value), ["c"]);
  assert.deepEqual(log.readFrom(4).map((e) => e.value), []);
});

test("a consumer that keeps up never misses the terminal event", () => {
  const log = new NotificationLog({ capacity: 50 });
  let cursor = 1;
  const seen = [];
  for (let i = 0; i < 500; i += 1) {
    log.append(i === 499 ? "turn/completed" : `event-${i}`);
    for (const entry of log.readFrom(cursor)) {
      cursor = log.cursorAfter(entry.seq);
      seen.push(entry.value);
    }
  }
  assert.equal(seen.length, 500);
  assert.equal(seen.at(-1), "turn/completed");
});

/**
 * The real defect: a consumer slower than the producer used to resume at the
 * wrong offset and silently never observe `turn/completed`. The log must either
 * serve the event or report that the cursor was evicted — never hang.
 */
test("a lagging consumer gets HISTORY_LOST instead of silently missing the terminal event", () => {
  const log = new NotificationLog({ capacity: 10 });
  const cursor = 1;
  for (let i = 0; i < 100; i += 1) log.append(`event-${i}`);
  log.append("turn/completed");

  assert.throws(() => log.readFrom(cursor), (error) => {
    assert.ok(error instanceof HistoryLostError);
    assert.equal(error.code, "HISTORY_LOST");
    assert.equal(error.requestedSeq, cursor);
    assert.ok(error.droppedCount > 0);
    return true;
  });
});

test("eviction keeps the newest events addressable", () => {
  const log = new NotificationLog({ capacity: 5 });
  for (let i = 0; i < 20; i += 1) log.append(`e${i}`);
  const tail = log.readFrom(log.oldestSeq);
  assert.equal(tail.length, 5);
  assert.equal(tail.at(-1).value, "e19");
  assert.equal(log.lastSeq, 20);
});

test("notifications produced during a burst are counted, not silently dropped", () => {
  const log = new NotificationLog({ capacity: 100 });
  for (let i = 0; i < 70_383; i += 1) log.append("delta");
  assert.equal(log.lastSeq, 70_383);
  assert.equal(log.size, 100);
  assert.equal(log.droppedCount, 70_383 - 100);
});
