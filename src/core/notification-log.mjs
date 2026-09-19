/**
 * Bounded, sequence-addressed notification log.
 *
 * The previous implementation kept an array plus a monotonic read cursor. Once
 * the array shifted on overflow, the cursor referred to a different entry, so
 * consumers silently skipped their own events — a real review turn emitted
 * 70,383 notifications and `turn/completed` was never observed even though it
 * was still buffered.
 *
 * Contract:
 *   - every appended notification gets a unique, monotonic `seq`
 *   - `readFrom(cursor)` returns events with `seq >= cursor`
 *   - if the requested cursor has been evicted, it throws `HistoryLostError`
 *     instead of silently resuming at a different point
 *   - eviction never makes a consumer wait forever for an already-emitted event
 *
 * The bound is configurable but the correctness guarantee does not depend on it.
 */

export class HistoryLostError extends Error {
  constructor({ requestedSeq, oldestSeq, droppedCount }) {
    super(
      `notification history lost: cursor ${requestedSeq} was evicted ` +
      `(oldest retained seq is ${oldestSeq}, ${droppedCount} dropped)`,
    );
    this.name = "HistoryLostError";
    this.code = "HISTORY_LOST";
    this.requestedSeq = requestedSeq;
    this.oldestSeq = oldestSeq;
    this.droppedCount = droppedCount;
  }
}

export class NotificationLog {
  constructor({ capacity = 4_096 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.entries = [];
    this.nextSeq = 1;
    // Cursors below this value can no longer be served.
    this.oldestSeq = 1;
    this.droppedCount = 0;
    this.listeners = new Set();
  }

  get size() {
    return this.entries.length;
  }

  /** Highest sequence handed out, or 0 when nothing was appended yet. */
  get lastSeq() {
    return this.nextSeq - 1;
  }

  append(value) {
    const seq = this.nextSeq++;
    this.entries.push({ seq, value });
    while (this.entries.length > this.capacity) {
      const dropped = this.entries.shift();
      this.oldestSeq = dropped.seq + 1;
      this.droppedCount += 1;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({ seq, value });
      } catch {
        // A listener must never break ingestion of server output.
      }
    }
    return seq;
  }

  /**
   * Events with `seq >= cursor`. Throws when the cursor was evicted so callers
   * can fail closed rather than mis-resume.
   */
  readFrom(cursor) {
    if (!Number.isInteger(cursor) || cursor < 1) {
      throw new Error("cursor must be a positive integer");
    }
    if (cursor < this.oldestSeq) {
      throw new HistoryLostError({
        requestedSeq: cursor,
        oldestSeq: this.oldestSeq,
        droppedCount: this.droppedCount,
      });
    }
    return this.entries.filter((entry) => entry.seq >= cursor);
  }

  /** Next cursor a consumer should pass to readFrom after consuming `upTo`. */
  cursorAfter(seq) {
    return seq + 1;
  }

  /** Drop entries the consumer no longer needs. */
  releaseBefore(cursor) {
    const keep = this.entries.filter((entry) => entry.seq >= cursor);
    if (keep.length !== this.entries.length) this.entries = keep;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
