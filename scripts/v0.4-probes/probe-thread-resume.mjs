/**
 * Probe: does `thread/resume` really reattach, and is the identity evidence it
 * feeds the Gate real?
 *
 * Fusion's restart story is "store `task -> executorThreadId`, then rejoin that
 * thread". That only works if `thread/resume` accepts a persisted id in a NEW
 * process and reports the same thread back. This probe measures exactly that,
 * across two separate app-server processes, because a same-process check would
 * not exercise the restart path at all.
 *
 * Steps:
 *   1. process 1: thread/start -> persist the thread id (this stands in for the
 *      Taskboard binding)
 *   2. process 1: run one real turn, so the thread has an actual rollout on disk
 *      (`FUSION_POC_TURN=0` skips this, which is how the "no rollout" behaviour
 *      was discovered)
 *   3. process 1: exit
 *   4. process 2: thread/resume(threadId) -> is it the same thread?
 *   5. process 2: thread/read(threadId)   -> what does the server report its
 *      own cwd/id to be? (this is what the Gate's identity evidence uses)
 *   6. negative controls: identity evidence against a wrong workspace, against a
 *      foreign thread id, and against an id that does not exist
 *
 * Read-only: the workspace is only opened, never modified.
 *
 * Env:
 *   FUSION_POC_MODEL        required
 *   FUSION_POC_MODEL_PROVIDER default "custom"
 *   FUSION_POC_CODEX_HOME   default D:\poc\v2-codex-home
 *   FUSION_POC_WORKSPACE    required, must be a trusted workspace
 *   FUSION_POC_OUT          optional JSON report path
 *   FUSION_POC_TURN         "1" (default) run a turn before restarting; "0" skip
 */
import fs from "node:fs";
import path from "node:path";
import { AppServerStdio } from "../../src/adapters/app-server-stdio.mjs";
import { collectIdentityEvidence } from "../../src/core/evidence.mjs";

const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const codexHome = process.env.FUSION_POC_CODEX_HOME ?? "D:\\poc\\v2-codex-home";
const workspacePath = process.env.FUSION_POC_WORKSPACE;
const outPath = process.env.FUSION_POC_OUT ?? null;
const runTurn = (process.env.FUSION_POC_TURN ?? "1") !== "0";

if (!model || !workspacePath) {
  console.error("Set FUSION_POC_MODEL and FUSION_POC_WORKSPACE.");
  process.exit(2);
}

const configPath = path.join(codexHome, "config.toml");
const trusted = fs.existsSync(configPath)
  && fs.readFileSync(configPath, "utf8").toLowerCase().includes(`[projects.'${workspacePath.toLowerCase()}']`);
if (!trusted) {
  console.error(`workspace is not trusted in ${configPath}: ${workspacePath}`);
  process.exit(2);
}

const report = { model, modelProvider, codexHome, workspacePath, runTurnBeforeRestart: runTurn, steps: [] };
const spawn = () => new AppServerStdio({ cwd: workspacePath, timeoutMs: 120_000, env: { CODEX_HOME: codexHome } });

// ------------------------------------------------ step 1: create + persist
let persistedThreadId = null;
{
  const server = spawn();
  try {
    await server.start();
    const thread = await server.startThread({
      cwd: workspacePath, model, modelProvider, sandbox: "workspace-write",
    });
    persistedThreadId = thread?.thread?.id ?? null;
    report.steps.push({
      step: "process1.thread/start",
      threadId: persistedThreadId,
      sandbox: thread?.sandbox?.type ?? null,
      historyMode: thread?.thread?.historyMode ?? null,
      persistedBinding: { taskThreadBinding: { threadId: persistedThreadId } },
    });
    if (!persistedThreadId) throw new Error("thread/start returned no thread id");

    // A thread with no turns has no rollout on disk, and `thread/resume` then
    // fails with `-32600 no rollout found`. Fusion's real executor runs a turn
    // before any restart, so the probe must do the same or it measures a state
    // that cannot occur in practice.
    if (runTurn) {
      const started = await server.startTurn({
        threadId: persistedThreadId,
        message: "Reply with exactly: RESUME_PROBE_OK",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      const done = await server.waitForTurn({
        threadId: persistedThreadId, turnId: started?.turn?.id ?? null, timeoutMs: 300_000,
      });
      report.steps.push({
        step: "process1.turn",
        turnId: done.turnId,
        status: done.status,
        agentText: done.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n").slice(0, 200),
      });
    }
  } catch (error) {
    report.steps.push({ step: "process1.thread/start", error: String(error) });
  } finally {
    await server.stop();
  }
}
report.process1Exited = true;

if (!persistedThreadId) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

// ------------------------------------- step 2..5: a brand-new process resumes
const server2 = spawn();
try {
  await server2.start();

  // The point of the probe: a process that never created this thread rejoins it.
  const resumed = await server2.resumeThread({ threadId: persistedThreadId, model, modelProvider, sandbox: "workspace-write" });
  const resumedThread = resumed?.thread ?? null;
  report.steps.push({
    step: "process2.thread/resume",
    requestedThreadId: persistedThreadId,
    resumedThreadId: resumedThread?.id ?? null,
    sameThreadId: (resumed?.thread?.id ?? null) === persistedThreadId,
    serverCwd: resumed?.cwd ?? null,
    serverSandbox: resumed?.sandbox?.type ?? null,
    serverModel: resumed?.model ?? null,
    turnCount: Array.isArray(resumedThread?.turns) ? resumedThread.turns.length : null,
    excludeTurnsHonoured: Array.isArray(resumedThread?.turns) ? resumedThread.turns.length === 0 : null,
  });

  const read = await server2.readThread({ threadId: persistedThreadId, includeTurns: false });
  const observed = read?.thread ?? null;
  report.steps.push({
    step: "process2.thread/read",
    threadId: observed?.id ?? null,
    cwd: observed?.cwd ?? null,
    sessionId: observed?.sessionId ?? null,
    source: observed?.source ?? null,
  });

  // ---- identity evidence, positive ----------------------------------------
  const binding = {
    threadId: persistedThreadId,
    workspacePath,
    codexProjectId: "probe",
    codexProjectKind: "local",
    codexHostId: "local",
  };
  const positive = await collectIdentityEvidence({
    appServer: server2, executorBinding: binding, workspacePath,
  });
  report.identityPositive = positive;

  // ---- identity evidence, negatives ---------------------------------------
  const wrongWorkspace = await collectIdentityEvidence({
    appServer: server2, executorBinding: binding, workspacePath: "D:\\poc\\not-the-workspace",
  });
  const foreignThread = await collectIdentityEvidence({
    appServer: server2,
    executorBinding: { ...binding, threadId: "00000000-0000-0000-0000-000000000000" },
    workspacePath,
  });
  const noThread = await collectIdentityEvidence({
    appServer: server2, executorBinding: { ...binding, threadId: null }, workspacePath,
  });
  report.identityNegatives = {
    wrongWorkspace: { identityMatches: wrongWorkspace.identityMatches, reasons: wrongWorkspace.reasons },
    foreignThread: { identityMatches: foreignThread.identityMatches, reasons: foreignThread.reasons },
    noThreadId: { identityMatches: noThread.identityMatches, reasons: noThread.reasons },
  };
} catch (error) {
  report.steps.push({ step: "process2", error: String(error) });
} finally {
  report.stderrTail = String(server2.lastStderr ?? "").split("\n").slice(-3).join("\n");
  await server2.stop();
}

// The decisive summary: resume worked, and identity is falsifiable.
report.summary = {
  resumeAcrossProcesses: report.steps.find((s) => s.step === "process2.thread/resume")?.sameThreadId === true,
  serverReportedCwd: report.steps.find((s) => s.step === "process2.thread/read")?.cwd ?? null,
  identityPositiveMatches: report.identityPositive?.identityMatches === true,
  identityRejectsWrongWorkspace: report.identityNegatives?.wrongWorkspace?.identityMatches === false,
  identityRejectsForeignThread: report.identityNegatives?.foreignThread?.identityMatches === false,
  identityRejectsMissingThreadId: report.identityNegatives?.noThreadId?.identityMatches === false,
};

const json = JSON.stringify(report, null, 2);
if (outPath) fs.writeFileSync(outPath, json, "utf8");
console.log(json);
