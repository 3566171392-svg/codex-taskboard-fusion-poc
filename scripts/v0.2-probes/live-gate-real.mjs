/**
 * Drive the v0.2 Thin Review Gate against the REAL app-server.
 *
 * The gate is used unmodified. Only its injected `appServer` dependency is
 * wrapped, and only to observe what the protocol actually returned:
 *
 *   Phase A  gate + real adapter, default executor thread (as the POC ships)
 *   Phase B  gate + real adapter, legacy executor thread (detached allowed)
 *   Phase C  gate verdict logic over the officially recommended path
 *            (separate read-only thread + inline review)
 *
 * Taskboard is a local in-memory board so no external service is required and
 * no real task data is touched.
 */
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";
import {
  deriveReviewVerdict,
  executeNativeReviewGate,
  parseNativeReviewOutput,
} from "../src/core/review-gate.mjs";

const cwd = process.env.FUSION_POC_CWD;
const model = process.env.FUSION_POC_MODEL ?? "<your-model>";
if (!cwd) { console.error("Set FUSION_POC_CWD."); process.exit(2); }

class MemoryBoard {
  constructor() { this.task = { id: "T-LIVE", version: 1, status: "todo" }; this.events = []; }
  async getTask() { return structuredClone(this.task); }
  async moveTask(id, status, version) {
    if (version !== this.task.version) throw new Error(`version conflict ${version} != ${this.task.version}`);
    this.task.status = status;
    this.task.version += 1;
    this.events.push(`move:${status}`);
    return structuredClone(this.task);
  }
  async addComment(_id, c) { this.events.push(`comment:${String(c.body).slice(0, 60)}`); }
}

const makeExecutor = (binding, board) => ({
  binding,
  async collectHandoff() {
    // Deterministic evidence: the real test suite in the real workspace.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    try {
      const { stdout } = await run(process.execPath, ["--test"], { cwd: binding.workspacePath });
      const pass = stdout.match(/^ℹ pass (\d+)$/m)?.[1];
      const fail = stdout.match(/^ℹ fail (\d+)$/m)?.[1];
      return { testsPassed: true, identityMatches: true, pass, fail };
    } catch (error) {
      const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      return {
        testsPassed: false,
        identityMatches: true,
        pass: out.match(/^ℹ pass (\d+)$/m)?.[1],
        fail: out.match(/^ℹ fail (\d+)$/m)?.[1],
      };
    }
  },
  async repair() { throw new Error("repair must not be called in this probe"); },
});

const report = { cwd, model, phases: {} };
const appServer = new AppServerStdio({ cwd, timeoutMs: 600_000 });

async function observeReviewAdapter(inner) {
  const observed = { startReviewParams: null, startReviewReply: null, reviewText: null, notificationMethods: [] };
  const wrapped = {
    async startReview(params) {
      observed.startReviewParams = params;
      try {
        const reply = await inner.startReview(params);
        observed.startReviewReply = reply;
        return reply;
      } catch (error) {
        observed.startReviewReply = { error: String(error) };
        throw error;
      }
    },
    async waitForReview({ turnId }) {
      const completed = await inner.waitForReview({ turnId });
      observed.reviewText = completed.reviewText ?? null;
      observed.notificationMethods = [...new Set(
        (inner.notifications ?? [])
          .filter((n) => n.params?.turnId === turnId || n.params?.turn?.id === turnId)
          .map((n) => (n.params?.item?.type ? `${n.method}:${n.params.item.type}` : n.method)),
      )];
      return completed;
    },
  };
  return { wrapped, observed };
}

try {
  await appServer.start();

  // ---------------- Phase A: as the POC ships (default thread) ------------
  {
    const board = new MemoryBoard();
    const created = await appServer.startThread({ cwd, model, modelProvider: "custom", sandbox: "workspace-write" });
    const threadId = created.thread?.id;
    const executor = { ...makeExecutor(
      { threadId, codexProjectId: "fusion-v2", codexProjectKind: "local", codexHostId: "local", workspacePath: cwd },
      board,
    ), async repair() {} };
    const { wrapped, observed } = await observeReviewAdapter(appServer);
    const phase = { executorThreadId: threadId, historyMode: created.thread?.historyMode ?? null };
    try {
      const result = await executeNativeReviewGate({
        taskId: "T-LIVE", task: await board.getTask(), executor, appServer: wrapped, taskboard: board,
      });
      phase.gateResult = { status: result.status, attempt: result.attempt };
    } catch (error) {
      phase.gateThrew = String(error);
    }
    phase.startReviewReply = observed.startReviewReply;
    phase.boardEvents = board.events;
    report.phases.shippedDefault = phase;
  }

  // ---------------- Phase B: legacy executor thread (detached allowed) ---
  {
    const board = new MemoryBoard();
    const created = await appServer.startThread({
      cwd, model, modelProvider: "custom", sandbox: "workspace-write", historyMode: "legacy",
    });
    const threadId = created.thread?.id;
    const executor = { ...makeExecutor(
      { threadId, codexProjectId: "fusion-v2", codexProjectKind: "local", codexHostId: "local", workspacePath: cwd },
      board,
    ), async repair() {} };
    const { wrapped, observed } = await observeReviewAdapter(appServer);
    const phase = { executorThreadId: threadId, historyMode: created.thread?.historyMode ?? null };
    try {
      const result = await executeNativeReviewGate({
        taskId: "T-LIVE", task: await board.getTask(), executor, appServer: wrapped, taskboard: board,
      });
      phase.gateResult = { status: result.status, attempt: result.attempt };
    } catch (error) {
      phase.gateThrew = String(error);
    }
    phase.reviewThreadId = observed.startReviewReply?.reviewThreadId ?? null;
    phase.reviewThreadIsIndependent =
      Boolean(phase.reviewThreadId) && phase.reviewThreadId !== threadId;
    phase.reviewTextIsJson = typeof observed.reviewText === "string" ? /^\s*\{/.test(observed.reviewText) : null;
    phase.reviewTextPresent = typeof observed.reviewText === "string";
    phase.reviewItemsSeen = observed.notificationMethods.filter((m) => /ReviewMode/.test(m));
    phase.boardEvents = board.events;
    report.phases.legacyDetached = phase;
  }

  // ---------------- Phase C: official replacement, gate verdict logic ----
  {
    const created = await appServer.startThread({
      cwd, model, modelProvider: "custom", sandbox: "read-only",
    });
    const reviewThreadId = created.thread?.id;
    const started = await appServer.startReview({
      threadId: reviewThreadId,
      delivery: "inline",
      target: { type: "uncommittedChanges" },
    });
    const completed = await appServer.waitForReview({ turnId: started.turn.id });
    const reviewText = completed.reviewText ?? "";
    const reviewItems = [...new Set(
      appServer.notifications
        .filter((n) => n.params?.turnId === started.turn.id)
        .filter((n) => n.params?.item?.type === "enteredReviewMode" || n.params?.item?.type === "exitedReviewMode")
        .map((n) => `${n.method}:${n.params.item.type}`),
    )];
    let parsed;
    let derived;
    let parseThrew = null;
    try {
      parsed = parseNativeReviewOutput(reviewText);
      derived = deriveReviewVerdict(parsed, { testsPassed: true, identityMatches: true });
    } catch (error) {
      parseThrew = String(error);
    }
    report.phases.recommendedPath = {
      reviewThreadId,
      reviewTurnId: started.turn.id,
      independentFromExecutorThread: true,
      reviewItems,
      reviewTextLength: reviewText.length,
      reviewTextIsJson: /^\s*\{/.test(reviewText),
      reviewTextHead: reviewText.slice(0, 200),
      parseThrew,
      parsedStructured: parsed?.structured ?? null,
      parsedOverallCorrectness: parsed?.overall_correctness ?? null,
      parsedFindings: parsed?.findings?.length ?? null,
      gateVerdict: derived?.verdict ?? null,
      gateReason: derived?.reason ?? null,
    };
  }
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = (appServer.lastStderr ?? "").split("\n").slice(-3).join("\n");
  await appServer.stop();
  console.log(JSON.stringify(report, null, 2));
}
