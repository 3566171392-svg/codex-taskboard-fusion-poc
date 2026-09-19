import assert from "node:assert/strict";
import test from "node:test";
import { collectIdentityEvidence, normalizeWorkspacePath } from "../src/core/evidence.mjs";
import { checkMachineEvidence } from "../src/core/review-gate.mjs";

const binding = {
  threadId: "exec-A",
  workspacePath: "D:\\ws\\project",
  codexProjectId: "p",
  codexProjectKind: "local",
  codexHostId: "local",
};

/** An app server that reports whatever the test wants the thread to look like. */
const serverReporting = ({ id = "exec-A", cwd = "D:\\ws\\project" } = {}) => ({
  async readThread({ threadId }) {
    return { thread: { id: id ?? threadId, cwd } };
  },
});

test("established identity requires the server to confirm thread and workspace", async () => {
  const evidence = await collectIdentityEvidence({
    appServer: serverReporting(),
    executorBinding: binding,
    workspacePath: binding.workspacePath,
  });
  assert.equal(evidence.identityMatches, true);
  assert.deepEqual(evidence.reasons, []);
  assert.equal(evidence.observedThreadId, "exec-A");
  assert.equal(evidence.source, "thread/read (app server)");
});

test("a thread whose workspace is different is not an identity match", async () => {
  const evidence = await collectIdentityEvidence({
    appServer: serverReporting({ cwd: "D:\\ws\\other" }),
    executorBinding: binding,
    workspacePath: binding.workspacePath,
  });
  assert.equal(evidence.identityMatches, false);
  assert.ok(evidence.reasons.some((r) => /not the binding/.test(r)), evidence.reasons.join("; "));
});

test("a server reporting a different thread id is not an identity match", async () => {
  const evidence = await collectIdentityEvidence({
    appServer: serverReporting({ id: "exec-B" }),
    executorBinding: binding,
    workspacePath: binding.workspacePath,
  });
  assert.equal(evidence.identityMatches, false);
  assert.ok(evidence.reasons.some((r) => /server returned thread/.test(r)));
});

test("evidence collected from a different workspace than the binding is not a match", async () => {
  const evidence = await collectIdentityEvidence({
    appServer: serverReporting(),
    executorBinding: binding,
    workspacePath: "D:\\ws\\elsewhere",
  });
  assert.equal(evidence.identityMatches, false);
  assert.ok(evidence.reasons.some((r) => /collected from/.test(r)));
});

test("an unobservable thread fails closed instead of defaulting to true", async () => {
  const failing = {
    async readThread() { throw new Error("thread not found"); },
  };
  const evidence = await collectIdentityEvidence({
    appServer: failing,
    executorBinding: binding,
    workspacePath: binding.workspacePath,
  });
  assert.equal(evidence.identityMatches, false);
  assert.match(evidence.observationError, /thread not found/);
});

test("a missing app server fails closed", async () => {
  const evidence = await collectIdentityEvidence({
    appServer: null,
    executorBinding: binding,
    workspacePath: binding.workspacePath,
  });
  assert.equal(evidence.identityMatches, false);
  assert.ok(evidence.reasons.some((r) => /no app server/.test(r)));
});

test("a binding without a thread id fails closed", async () => {
  const evidence = await collectIdentityEvidence({
    appServer: serverReporting(),
    executorBinding: { workspacePath: "D:\\ws\\project" },
    workspacePath: "D:\\ws\\project",
  });
  assert.equal(evidence.identityMatches, false);
  assert.ok(evidence.reasons.some((r) => /no threadId/.test(r)));
});

test("path normalization is case- and separator-insensitive, but never lossy", () => {
  assert.equal(normalizeWorkspacePath("D:\\WS\\Project"), normalizeWorkspacePath("d:/ws/project"));
  assert.equal(normalizeWorkspacePath("D:\\ws\\project\\"), normalizeWorkspacePath("D:\\ws\\project"));
  assert.notEqual(normalizeWorkspacePath("D:\\ws\\project"), normalizeWorkspacePath("D:\\ws\\project2"));
  assert.equal(normalizeWorkspacePath(""), null);
  assert.equal(normalizeWorkspacePath(null), null);
});

/**
 * The Gate must not pass on a missing identity value. An earlier revision tested
 * `identityMatches === false`, so evidence that simply omitted the field passed
 * the check by omission — the security check never fired.
 */
test("the Gate blocks identity that is absent, not just identity that is false", () => {
  const base = {
    executorThreadId: "A",
    reviewerThreadId: "B",
    reviewerSandbox: "readOnly",
    reviewTurnStatus: "completed",
    reviewMode: { entered: 1, exited: 1 },
  };

  const absent = checkMachineEvidence({ ...base, evidence: { allChecksPassed: true } });
  assert.equal(absent.verdict, "BLOCKED");
  assert.match(absent.reason, /identity was not established/);

  const explicitFalse = checkMachineEvidence({
    ...base,
    evidence: { allChecksPassed: true, identityMatches: false, identityReasons: ["workspace mismatch"] },
  });
  assert.equal(explicitFalse.verdict, "BLOCKED");
  assert.match(explicitFalse.reason, /workspace mismatch/);

  const established = checkMachineEvidence({
    ...base,
    evidence: { allChecksPassed: true, identityMatches: true },
  });
  assert.equal(established, null);
});
