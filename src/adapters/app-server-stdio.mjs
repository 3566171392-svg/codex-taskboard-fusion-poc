import { spawn } from "node:child_process";
import readline from "node:readline";
import { HistoryLostError, NotificationLog } from "../core/notification-log.mjs";
import { toFilesystemPath } from "../core/paths.mjs";

function asRpcId(value) {
  return Number.isInteger(value) ? value : String(value);
}

/** Parameters `thread/start` accepts on this protocol version. */
const THREAD_START_KEYS = new Set([
  "cwd", "model", "modelProvider", "sandbox", "historyMode", "approvalPolicy",
  "baseInstructions", "developerInstructions", "ephemeral", "personality",
  "projectId", "serviceName", "serviceTier", "threadSource", "config",
]);

/** Parameters `turn/start` accepts on this protocol version. */
const TURN_START_KEYS = new Set([
  "threadId", "input", "sandboxPolicy", "outputSchema", "approvalPolicy",
  "cwd", "effort", "model", "summary", "clientUserMessageId", "personality",
  "serviceTier",
]);

/** Parameters `review/start` accepts on this protocol version. */
const REVIEW_START_KEYS = new Set(["threadId", "target", "delivery"]);

/** Parameters `thread/resume` accepts on this protocol version. */
const THREAD_RESUME_KEYS = new Set([
  "threadId", "cwd", "model", "modelProvider", "sandbox", "permissions",
  "approvalPolicy", "approvalsReviewer", "baseInstructions", "developerInstructions",
  "personality", "serviceTier", "config", "excludeTurns", "initialTurnsPage",
  "runtimeWorkspaceRoots",
]);

/** Review targets accepted by `review/start` on this protocol version. */
const REVIEW_TARGETS = new Set(["uncommittedChanges", "baseBranch", "commit", "custom"]);

/** Review-mode item types emitted by Codex's review lifecycle. */
export const REVIEW_MODE_ITEMS = Object.freeze({
  ENTERED: "enteredReviewMode",
  EXITED: "exitedReviewMode",
});

function assertKnownKeys(object, allowed, method) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${method} received unsupported parameter(s): ${unknown.join(", ")}. ` +
      "Refusing to call the server with parameters it will not receive.",
    );
  }
}

/**
 * Parse the final assistant message as JSON.
 *
 * Codex's App Server does not surface a distinct structured-output item on this
 * build — the schema-constrained JSON arrives as the last `agentMessage`. This
 * returns `null` when there is no parsable object, and the caller must treat
 * that as BLOCKED rather than falling back to prose.
 */
export function parseStructuredOutput(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const attempt = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(trimmed);
  if (direct) return direct;
  // Tolerate a fenced or wrapped object, but never invent one from prose.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return attempt(trimmed.slice(start, end + 1));
}

export class AppServerStdio {
  constructor({ executable = "codex", args = ["app-server", "--stdio"], cwd, env = {}, timeoutMs = 120_000 } = {}) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.readline = null;
    // Sequence-addressed, eviction-aware. `historyLost` surfaces a bounded
    // log that outran a consumer instead of hanging it forever.
    this.log = new NotificationLog({ capacity: 4_096 });
  }

  /** Snapshot of raw notification values, oldest first (may be truncated). */
  get notifications() {
    return this.log.entries.map((entry) => entry.value);
  }

  async start() {
    if (this.child) throw new Error("AppServerStdio already started");
    this.child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.readline = readline.createInterface({ input: this.child.stdout });
    this.readline.on("line", (line) => this.#handleLine(line));
    this.child.stderr.on("data", (data) => {
      this.lastStderr = `${this.lastStderr ?? ""}${data}`.slice(-16_384);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited: code=${code} signal=${signal}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.child = null;
    });

    await this.request("initialize", {
      clientInfo: { name: "codex-taskboard-fusion-poc", title: "Fusion POC", version: "0.4.0" },
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized", {});
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.readline?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    this.child = null;
  }

  async notify(method, params = {}) {
    if (!this.child) throw new Error("app-server is not started");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child) throw new Error("app-server is not started");
    const id = asRpcId(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.child.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /**
   * Start a thread. Every caller-supplied parameter is forwarded verbatim.
   *
   * `historyMode` in particular must reach the server: detached review is
   * refused on paginated threads, so silently dropping it made the caller's
   * intent unreachable. Unsupported keys are rejected here rather than being
   * discarded, so a dropped parameter can never again look like a server
   * behaviour change.
   */
  async startThread(params = {}) {
    assertKnownKeys(params, THREAD_START_KEYS, "thread/start");
    return this.request("thread/start", { ...params });
  }

  /** Start a thread and wait for its `turn/completed` notification. */
  async runThreadTurn(params = {}) {
    const started = await this.startTurn(params);
    const turnId = started.turn?.id ?? null;
    const turn = await this.waitForTurn({ threadId: params.threadId, turnId });
    return { turn, turnId };
  }

  /**
   * Reattach to an existing thread by id and return its server-reported state.
   *
   * This is the whole of Fusion's restart story: Fusion stores only
   * `task -> executorThreadId`, and uses `thread/resume` to rejoin that thread.
   * It does not replay a transcript and does not reconstruct Codex context —
   * the thread's history lives with Codex, not with Fusion.
   *
   * The response is also the only trustworthy source for identity binding: it
   * reports the thread id, the workspace the server actually opened (`cwd`,
   * absolutely normalized), and the model/provider/sandbox in force. A local
   * path comparison cannot establish that, because Fusion would be comparing a
   * stored string against itself.
   */
  async resumeThread(params = {}) {
    assertKnownKeys(params, THREAD_RESUME_KEYS, "thread/resume");
    if (!params.threadId) throw new Error("thread/resume requires a threadId");
    // Full-history hydration is deprecated for paginated threads and Fusion does
    // not consume the transcript, so ask for metadata only.
    return this.request("thread/resume", { excludeTurns: true, ...params });
  }

  /**
   * Describe an existing thread without resuming it.
   *
   * `thread/read` reports the thread's own view of itself, including its `cwd`.
   * Used by the identity check to verify a binding independently of resume.
   */
  async readThread({ threadId, includeTurns = false } = {}) {
    if (!threadId) throw new Error("thread/read requires a threadId");
    return this.request("thread/read", { threadId, includeTurns });
  }

  /**
   * Start a turn. `message` is a convenience for the common text-only case;
   * `input` passes through unchanged when a caller needs richer input.
   * `outputSchema` is forwarded verbatim (the protocol types it as free-form
   * `Option<JsonValue>`).
   */
  async startTurn({
    threadId,
    message,
    input,
    sandboxPolicy = { type: "workspaceWrite", networkAccess: false },
    outputSchema,
    ...rest
  } = {}) {
    assertKnownKeys(rest, TURN_START_KEYS, "turn/start");
    const payload = {
      threadId,
      input: input ?? [{ type: "text", text: message }],
      sandboxPolicy,
      ...rest,
    };
    if (outputSchema !== undefined) payload.outputSchema = outputSchema;
    return this.request("turn/start", payload);
  }

  /** Start a turn constrained by a JSON Schema for its final message. */
  async startTurnWithSchema({ outputSchema, ...params } = {}) {
    if (!outputSchema || typeof outputSchema !== "object") {
      throw new Error("outputSchema must be a JSON Schema object");
    }
    return this.startTurn({ ...params, outputSchema });
  }

  /**
   * Start a Codex-native review on an existing thread.
   *
   * `delivery: "detached"` is deliberately not offered. Measured on this build:
   *   - the server refuses it on paginated threads with
   *     `-32600 paginated threads do not support detached review`
   *   - it is marked deprecated and emits a `deprecationNotice` on every call
   *   - it runs an agent invocation, not the review task, so it never emits
   *     `enteredReviewMode` / `exitedReviewMode`
   * The supported pattern is: a separate reviewer thread, then an inline review
   * on that thread. That is what the Review Gate uses.
   */
  async startReview({ threadId, target = { type: "uncommittedChanges" }, delivery = "inline" } = {}) {
    if (delivery !== "inline") {
      throw new Error(
        `review/start delivery "${delivery}" is not supported by this POC: ` +
        "detached review is deprecated and never emits the review lifecycle. " +
        "Create a separate reviewer thread and use delivery \"inline\".",
      );
    }
    if (!target || typeof target !== "object" || !REVIEW_TARGETS.has(target.type)) {
      throw new Error(
        `review/start target.type must be one of: ${[...REVIEW_TARGETS].join(", ")}`,
      );
    }
    assertKnownKeys({ threadId, target, delivery }, REVIEW_START_KEYS, "review/start");
    return this.request("review/start", { threadId, target, delivery });
  }

  /**
   * Wait for a review turn to finish and collect the review lifecycle.
   *
   * Returns `{ turnId, status, error, items, review, reviewMode, notifications }`
   * where `review` is the text Codex attached to `exitedReviewMode`, and
   * `reviewMode` records whether both lifecycle items were observed. A review
   * that completes without the lifecycle is reported as such — the caller must
   * not treat it as a successful review.
   */
  async waitForReview({ threadId, turnId = null, timeoutMs = 900_000 } = {}) {
    const completed = await this.waitForTurn({ threadId, turnId, timeoutMs });
    const reviewMode = { entered: 0, exited: 0 };
    let reviewText = null;

    for (const message of completed.notifications) {
      const item = message?.params?.item;
      if (!item || typeof item.type !== "string") continue;
      if (item.type === REVIEW_MODE_ITEMS.ENTERED) reviewMode.entered += 1;
      if (item.type === REVIEW_MODE_ITEMS.EXITED) {
        reviewMode.exited += 1;
        if (typeof item.review === "string") reviewText = item.review;
      }
    }

    // The review body also surfaces as the final agent message on some builds;
    // prefer the lifecycle text but fall back only when the lifecycle is absent.
    if (reviewText === null) {
      const agentText = completed.items
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text)
        .join("\n");
      if (agentText) reviewText = agentText;
    }

    return {
      turnId: completed.turnId,
      status: completed.status,
      error: completed.error ?? null,
      items: completed.items,
      notifications: completed.notifications,
      review: reviewText,
      reviewMode,
    };
  }

  /**
   * Wait for a turn to finish, consuming notifications from a sequence cursor.
   *
   * Returns `{ turnId, status, error, items, notifications, structuredOutput }`
   * where `structuredOutput` is the parsed JSON of the final agent message when
   * `outputSchema` constrained it. Throws `HistoryLostError` if this consumer
   * fell behind the bounded log — never an unbounded wait for an event that was
   * already emitted.
   */
  async waitForTurn({ threadId, turnId = null, timeoutMs = 900_000 } = {}) {
    const notifications = [];
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn(value);
      };
      const done = finish(resolve);
      const fail = finish(reject);

      const timer = setTimeout(() => {
        fail(new Error(`timeout waiting for turn ${turnId ?? "(any)"} on ${threadId}`));
      }, timeoutMs);

      const onChange = () => {
        // Drain synchronously from our own cursor. Subscribing first means this
        // consumer can never be evicted by its own slow polling: every event is
        // observed before the bounded log trims.
        let batch;
        try {
          batch = this.log.readFrom(cursor);
        } catch (error) {
          if (error instanceof HistoryLostError) {
            error.message = `waiting for turn ${turnId ?? "(any)"} on ${threadId}: ${error.message}`;
          }
          fail(error);
          return;
        }
        for (const entry of batch) {
          cursor = this.log.cursorAfter(entry.seq);
          const message = entry.value;
          const onThread = threadId === undefined || message?.params?.threadId === threadId;
          const onTurn = turnId === null
            || message?.params?.turnId === turnId
            || message?.params?.turn?.id === turnId;
          if (!onThread || !onTurn) continue;
          notifications.push(message);

          if (message.method === "turn/completed") {
            const turn = message.params?.turn ?? null;
            if (turnId !== null && turn?.id !== turnId) continue;
            const agentMessages = (turn?.items ?? [])
              .filter((item) => item.type === "agentMessage")
              .map((item) => item.text);
            done({
              turnId: turn?.id ?? turnId,
              status: turn?.status ?? null,
              error: turn?.error ?? null,
              items: turn?.items ?? [],
              notifications,
              structuredOutput: parseStructuredOutput(agentMessages.at(-1)),
            });
            return;
          }
        }
      };

      let cursor = this.log.lastSeq + 1;
      const unsubscribe = this.log.subscribe(onChange);
      // Events that landed between reading lastSeq and subscribing.
      onChange();
    });
  }

  /**
   * Read notifications from an explicit cursor. Throws `HistoryLostError` when
   * the cursor was evicted, so a late reader fails closed instead of resuming
   * at the wrong offset.
   */
  readNotificationsFrom(cursor) {
    return this.log.readFrom(cursor);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${message.error.code ?? "RPC_ERROR"}: ${message.error.message ?? "unknown"}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    this.log.append(message);
  }
}
