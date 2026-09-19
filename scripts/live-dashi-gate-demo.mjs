/**
 * Real end-to-end run against a REAL dashi Taskboard.
 *
 *   dashi task (created here, persisted)
 *     -> Executor thread A implements
 *     -> machine evidence: the project's own test command, real exit code
 *     -> native Reviewer thread B (read-only, native review/start)  -> FAIL
 *     -> task todo -> in_progress
 *     -> Executor A repairs (same thread)
 *     -> native Reviewer thread C                                   -> PASS
 *     -> READY_FOR_ACCEPTANCE persisted on the task
 *
 * Modes (env FUSION_POC_DASHI_MODE):
 *   run      (default) execute the gate from the task's durable state
 *   resume   re-read the task from dashi and report what it would do; performs
 *            no executor or reviewer work
 *
 * Nothing is mocked. The Taskboard adapter is the POC's own TaskboardHttp.
 *
 * Env:
 *   FUSION_POC_TASKBOARD_URL, FUSION_POC_PROJECT_ID, FUSION_POC_WORKSPACE,
 *   FUSION_POC_MODEL, FUSION_POC_TASK_ID (resume mode)
 */
import { TaskboardHttp } from "../src/adapters/taskboard-http.mjs";
import { AppServerStdio } from "../src/adapters/app-server-stdio.mjs";
import { readTaskState, runTaskThroughGate } from "../src/core/orchestrator.mjs";
import { collectEvidence, fingerprintWorkspace } from "../src/core/evidence.mjs";

const baseUrl = process.env.FUSION_POC_TASKBOARD_URL;
const projectId = process.env.FUSION_POC_PROJECT_ID ?? "demo-project";
const workspacePath = process.env.FUSION_POC_WORKSPACE;
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const mode = process.env.FUSION_POC_DASHI_MODE ?? "run";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 900_000);

if (!baseUrl || !workspacePath || !model) {
  console.error("Set FUSION_POC_TASKBOARD_URL, FUSION_POC_WORKSPACE and FUSION_POC_MODEL.");
  process.exit(2);
}

const board = new TaskboardHttp({ baseUrl, actorId: "fusion-gate", actorName: "Fusion Gate" });
const report = { mode, baseUrl, projectId, workspacePath, model, modelProvider };

// ---------------------------------------------------------------- resume
if (mode === "resume") {
  const taskId = process.env.FUSION_POC_TASK_ID;
  if (!taskId) { console.error("Set FUSION_POC_TASK_ID for resume mode."); process.exit(2); }
  const state = await readTaskState({ taskboard: board, taskId });
  report.taskId = taskId;
  report.task = {
    identifier: state.task.identifier,
    status: state.task.status,
    version: state.task.version,
    executorThreadId: state.task.threadBinding?.threadId ?? null,
    executorBinding: state.task.threadBinding ?? null,
  };
  report.attempts = state.attempts;
  report.resume = state.resume;
  report.threadIds = {
    executor: state.attempts[0]?.executorThreadId ?? null,
    reviewers: [...new Set(state.attempts.map((a) => a.reviewerThreadId).filter(Boolean))],
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- run
const taskContract = {
  title: "TASK3: 修复中途加入导致的房间卡死",
  description: [
    "game-core.js 的 join() 没有 phase 守卫：玩家可在 armed / finished 阶段加入，",
    "导致本轮永久卡死（phase 停留在 armed，无法到达 finished），",
    "且中途加入者可以抢占名次分。",
    "",
    "需要实现：",
    "1. join() 仅在 phase === 'waiting' 时接受加入，其他阶段返回 { accepted: false, reason: 'ROUND_IN_PROGRESS' }。",
    "2. public/app.js 在加入被拒且 reason === 'ROUND_IN_PROGRESS' 时，在 #join-error 显示「本轮进行中，请等下一轮」。",
    "3. nextRound() / reset() 后 phase 回到 waiting，新玩家可再次加入。",
    "",
    "契约与验收条件见仓库 docs/TASK3.md。不得修改或删除既有测试与既有断言；",
    "不得改动 src/static.js、public/index.html、public/style.css；不得新增运行时依赖。",
  ].join("\n"),
};

const acceptanceCriteria = [
  "armed 阶段 join() 返回 { accepted: false, reason: 'ROUND_IN_PROGRESS' }，且 players 数量不变",
  "finished 阶段 join() 同样被拒",
  "waiting 阶段 join() 仍正常（不破坏既有加入流程）",
  "卡死场景消失：arm() 后两人都点击，phase 到达 finished",
  "nextRound() 后 phase === 'waiting'，新玩家可加入",
  "既有测试一个都不许改，且必须继续通过",
];

const requiredChecks = [
  { command: process.execPath, args: ["--test", "test/game-core.test.js", "test/server.test.js"], timeoutMs: 300_000 },
];

const reviewScope = [
  "src/game-core.js",
  "src/server.js",
  "public/app.js",
  "test/game-core.test.js",
  "test/server.test.js",
  "docs/TASK3.md",
];

try {
  // ---- project + task on the real board --------------------------------
  try {
    await board.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: projectId, name: "LAN Reaction Game", workspacePath }),
    });
  } catch { /* already exists */ }

  let taskId = process.env.FUSION_POC_TASK_ID ?? null;
  if (!taskId) {
    const created = await board.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        title: taskContract.title,
        description: taskContract.description,
        status: "todo",
        priority: "high",
      }),
    });
    taskId = created.task.id;
    report.taskCreated = {
      taskId,
      identifier: created.task.identifier,
      status: created.task.status,
      version: created.task.version,
    };
  } else {
    report.taskReused = taskId;
  }
  report.taskId = taskId;

  // ---- executor thread A (workspace-write) ------------------------------
  const appServer = new AppServerStdio({ cwd: workspacePath, timeoutMs: 120_000 });
  await appServer.start();

  const executorThread = await appServer.startThread({
    cwd: workspacePath, model, modelProvider, sandbox: "workspace-write",
  });
  const executorThreadId = executorThread?.thread?.id ?? null;
  if (!executorThreadId) throw new Error("executor thread/start returned no thread id");
  report.executorThread = {
    threadId: executorThreadId,
    sandbox: executorThread?.sandbox?.type ?? null,
  };

  // Bind the executor thread to the task before any work is claimed, so the
  // binding is durable even if the run dies mid-flight.
  const before = await board.getTask(taskId);
  const binding = {
    threadId: executorThreadId,
    codexProjectId: projectId,
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  };
  const claimed = await board.moveTask(taskId, "in_progress", before.version, binding);
  report.claim = {
    status: claimed.status,
    version: claimed.version,
    executorBindingPersisted: claimed.threadBinding?.threadId === executorThreadId,
  };

  let baseline = fingerprintWorkspace(workspacePath);
  const executor = {
    binding,
    async collectHandoff({ attempt }) {
      const started = Date.now();
      let implementationText = "";
      if (attempt === 1) {
        // Implement from the task contract on the real project.
        const instruction = [
          "You are the executor for the repository at this workspace.",
          `Workspace: ${workspacePath}`,
          "Implement the task described in docs/TASK3.md.",
          "",
          "TASK:",
          taskContract.description,
          "",
          "Read docs/TASK3.md first for the full contract and acceptance criteria.",
          "Only change files the contract allows. Do not modify or delete existing tests or assertions.",
          "Run `node --test test/game-core.test.js test/server.test.js` yourself and report the result.",
        ].join("\n");
        const t = await appServer.startTurn({
          threadId: executorThreadId,
          message: instruction,
          sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        });
        const done = await appServer.waitForTurn({ threadId: executorThreadId, turnId: t.turn?.id ?? null, timeoutMs });
        implementationText = done.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
        report.implementation = {
          turnId: done.turnId,
          status: done.status,
          agentTextHead: implementationText.slice(0, 1_200),
        };
      }
      const evidence = await collectEvidence({ workspacePath, requiredChecks, fingerprintBefore: baseline, timeoutMs });
      report.evidenceRuns = report.evidenceRuns ?? [];
      report.evidenceRuns.push({
        attempt,
        allChecksPassed: evidence.allChecksPassed,
        checks: evidence.checks.map((c) => ({ command: c.command, passed: c.passed, exitCode: c.exitCode })),
        changedFiles: evidence.git?.changedFiles ?? null,
        elapsedMs: Date.now() - started,
      });
      return evidence;
    },
    async repair({ reviewerFindings, attempt }) {
      baseline = fingerprintWorkspace(workspacePath);
      const instruction = [
        "You are the executor for this repository.",
        `Workspace: ${workspacePath}`,
        "",
        "An independent reviewer rejected your work. Its review:",
        "-----",
        String(reviewerFindings ?? "").slice(0, 6_000),
        "-----",
        "",
        "Fix the real defect so the task's acceptance criteria hold.",
        "Do not modify or delete existing tests or assertions. Do not add files outside scope.",
        "Run `node --test test/game-core.test.js test/server.test.js` and report the result.",
      ].join("\n");
      const t = await appServer.startTurn({
        threadId: executorThreadId,
        message: instruction,
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
      });
      const done = await appServer.waitForTurn({ threadId: executorThreadId, turnId: t.turn?.id ?? null, timeoutMs });
      const text = done.items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n");
      report.repairs = report.repairs ?? [];
      report.repairs.push({
        attempt,
        threadId: executorThreadId,
        turnId: done.turnId,
        status: done.status,
        agentTextHead: text.slice(0, 800),
      });
    },
  };

  const result = await runTaskThroughGate({
    taskboard: board,
    taskId,
    executor,
    appServer,
    model,
    modelProvider,
    maxAttempts: 3,
    reviewTimeoutMs: timeoutMs,
    acceptanceCriteria,
    requiredChecks,
    reviewScope,
  });

  report.gate = {
    status: result.status,
    resumed: result.resumed,
    attemptedWork: result.attemptedWork,
    attempt: result.gate?.attempt ?? null,
    reviewerThreadIds: result.gate?.reviewerThreadIds ?? [],
    trace: result.gate?.trace ?? [],
    resumeReason: result.resume?.reason ?? null,
  };
  report.finalTask = result.task;
  report.attempts = result.attempts;

  await appServer.stop();
} catch (error) {
  report.error = String(error);
}

// Independent verification, straight from the Taskboard and the disk.
try {
  if (report.taskId) {
    const persisted = await readTaskState({ taskboard: board, taskId: report.taskId });
    report.persisted = {
      status: persisted.task.status,
      version: persisted.task.version,
      executorThreadId: persisted.task.threadBinding?.threadId ?? null,
      attemptCount: persisted.attempts.length,
      attempts: persisted.attempts.map((a) => ({
        attempt: a.attempt,
        executorThreadId: a.executorThreadId,
        reviewerThreadId: a.reviewerThreadId,
        verdict: a.verdict,
        reviewerBindingOnComment: a.reviewerBindingOnComment,
      })),
      resume: persisted.resume,
    };
  }
  const finalEvidence = await collectEvidence({ workspacePath, requiredChecks, timeoutMs }).catch(() => null);
  report.groundTruth = finalEvidence
    ? {
        checks: finalEvidence.checks.map((c) => ({ command: c.command, passed: c.passed, exitCode: c.exitCode })),
        changedFiles: finalEvidence.git?.changedFiles ?? null,
      }
    : null;
} catch (error) {
  report.verificationError = String(error);
}

console.log(JSON.stringify(report, null, 2));
