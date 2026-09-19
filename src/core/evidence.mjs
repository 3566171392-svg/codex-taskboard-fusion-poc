/**
 * Machine evidence collection.
 *
 * The Gate must never rely on a model's description of its own work. This module
 * gathers facts the Gate can check by itself: workspace fingerprint, git state,
 * and the real exit status of the required verification commands.
 *
 * Everything here is observation only — no command mutates the workspace.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Normalize a path for identity comparison.
 *
 * Windows paths are case-insensitive and may arrive with either separator, a
 * trailing separator, or a different drive-letter case. Comparing raw strings
 * would produce false mismatches, and — worse — a false *match* is impossible to
 * get wrong in the safe direction, so the normalization must only ever make two
 * genuinely identical locations compare equal.
 */
export function normalizeWorkspacePath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let p = value.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (p === "") return null;
  // A drive-letter prefix is case-insensitive on Windows.
  p = p.replace(/^([A-Za-z]):/, (_m, drive) => `${drive.toLowerCase()}:`);
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Build the Gate's identity evidence from server-observed facts.
 *
 * This exists because the Gate treats `identityMatches` as a PASS condition. An
 * earlier revision checked that field while nothing ever produced it, so the
 * check silently never fired — a security check with no evidence behind it.
 *
 * `identityMatches` is true only when all of the following hold, each verified
 * against something the App Server reported rather than against a value Fusion
 * stored itself:
 *
 *   1. the thread the binding names still exists and reports that same id,
 *   2. the server reports a `cwd` for that thread,
 *   3. that `cwd` is the workspace the binding claims, and
 *   4. that workspace matches the one the evidence was collected from.
 *
 * Returns the evidence plus a `reasons` list, so a mismatch is diagnosable
 * rather than just a boolean. Any error while observing produces
 * `identityMatches: false` — failing closed, never open.
 */
export async function collectIdentityEvidence({
  appServer,
  executorBinding,
  workspacePath = executorBinding?.workspacePath ?? null,
  verifyThread = true,
} = {}) {
  const binding = executorBinding ?? {};
  const expectedWorkspace = normalizeWorkspacePath(binding.workspacePath);
  const evidenceWorkspace = normalizeWorkspacePath(workspacePath);
  const reasons = [];
  const threadId = binding.threadId ?? null;

  if (!threadId) reasons.push("executor binding carries no threadId");
  if (!expectedWorkspace) reasons.push("executor binding carries no workspacePath");
  if (!evidenceWorkspace) reasons.push("no workspacePath supplied for evidence collection");
  if (expectedWorkspace && evidenceWorkspace && expectedWorkspace !== evidenceWorkspace) {
    reasons.push(
      `evidence was collected from ${workspacePath} but the binding claims ${binding.workspacePath}`,
    );
  }

  let observedThreadId = null;
  let observedCwd = null;
  let observedNormalized = null;
  let observed = false;
  let observationError = null;

  if (verifyThread && appServer && threadId) {
    try {
      const read = await appServer.readThread({ threadId, includeTurns: false });
      const thread = read?.thread ?? null;
      observed = true;
      observedThreadId = thread?.id ?? null;
      observedCwd = thread?.cwd ?? null;
      observedNormalized = normalizeWorkspacePath(observedCwd);
      if (observedThreadId !== threadId) {
        reasons.push(`server returned thread ${observedThreadId} for requested thread ${threadId}`);
      }
      if (!observedCwd) {
        reasons.push("server reported no cwd for the bound thread");
      }
    } catch (error) {
      observationError = String(error);
      reasons.push(`could not observe the bound thread: ${observationError}`);
    }
  } else if (verifyThread && !appServer) {
    reasons.push("no app server available to observe the bound thread");
  }

  if (observedNormalized && expectedWorkspace && observedNormalized !== expectedWorkspace) {
    reasons.push(
      `the bound thread's workspace is ${observedCwd}, not the binding's ${binding.workspacePath}`,
    );
  }

  const identityMatches = reasons.length === 0;

  return {
    identityMatches,
    reasons,
    boundThreadId: threadId,
    observedThreadId,
    observedCwd,
    expectedWorkspace: binding.workspacePath ?? null,
    evidenceWorkspace: workspacePath ?? null,
    threadObserved: observed,
    observationError,
    source: observed ? "thread/read (app server)" : "unverified",
  };
}

/** Directories that are never part of the reviewable content. */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".live", ".poc", "dist", "build"]);

/**
 * Deterministic fingerprint of the workspace tree.
 *
 * Path + size + content hash for every reviewable file, so "the workspace did
 * not change" and "the workspace changed exactly here" are both checkable.
 */
export function fingerprintWorkspace(root, { maxFiles = 20_000 } = {}) {
  const entries = [];
  const walk = (dir, prefix) => {
    if (entries.length >= maxFiles) return;
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile()) continue;
      try {
        const bytes = fs.readFileSync(full);
        entries.push({
          path: rel,
          bytes: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
        });
      } catch {
        entries.push({ path: rel, bytes: null, hash: null, unreadable: true });
      }
      if (entries.length >= maxFiles) return;
    }
  };
  walk(root, "");
  const digest = createHash("sha256")
    .update(entries.map((e) => `${e.path}\t${e.bytes}\t${e.hash}`).join("\n"))
    .digest("hex");
  return { root, count: entries.length, digest, entries };
}

/** Differences between two fingerprints, as path lists. */
export function diffFingerprints(before, after) {
  const beforeMap = new Map(before.entries.map((e) => [e.path, e]));
  const afterMap = new Map(after.entries.map((e) => [e.path, e]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [p, e] of afterMap) {
    const b = beforeMap.get(p);
    if (!b) added.push(p);
    else if (b.hash !== e.hash || b.bytes !== e.bytes) modified.push(p);
  }
  for (const p of beforeMap.keys()) if (!afterMap.has(p)) removed.push(p);
  return { added, removed, modified, identical: added.length + removed.length + modified.length === 0 };
}

/** Read-only git state. Returns null when the path is not a git work tree. */
export async function readGitState(workspacePath) {
  const run = async (args) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: workspacePath, timeout: 30_000 });
      return stdout;
    } catch (error) {
      return error?.stdout ?? null;
    }
  };
  const inside = await run(["rev-parse", "--is-inside-work-tree"]);
  if (!inside || inside.trim() !== "true") return { isRepo: false };
  const [status, diffStat, head] = await Promise.all([
    run(["status", "--porcelain"]),
    run(["diff", "--stat"]),
    run(["rev-parse", "HEAD"]),
  ]);
  const changed = (status ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    isRepo: true,
    head: (head ?? "").trim() || null,
    changedFiles: changed,
    dirty: changed.length > 0,
    diffStat: (diffStat ?? "").trim() || null,
  };
}

/**
 * Run one verification command and capture its real exit status.
 * Never throws: a failure is data, not an error path.
 */
export async function runVerification({ workspacePath, command, args = [], timeoutMs = 300_000 }) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workspacePath,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      command: [command, ...args].join(" "),
      passed: true,
      exitCode: 0,
      elapsedMs: Date.now() - started,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    };
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    return {
      command: [command, ...args].join(" "),
      passed: false,
      exitCode,
      elapsedMs: Date.now() - started,
      failureReason: error?.killed ? `timed out after ${timeoutMs}ms` : (error?.message ?? String(error)),
      stdoutTail: tail(error?.stdout ?? ""),
      stderrTail: tail(error?.stderr ?? ""),
    };
  }
}

function tail(text, lines = 12) {
  return String(text ?? "").split(/\r?\n/).slice(-lines).join("\n").trim();
}

/**
 * Build the full evidence bundle for one review attempt.
 *
 * `requiredChecks` is the acceptance-critical list; a non-empty `failed` array
 * is what makes the Gate return FAIL independently of the reviewer.
 */
export async function collectEvidence({
  workspacePath,
  requiredChecks = [],
  fingerprintBefore = null,
  timeoutMs = 300_000,
}) {
  const git = await readGitState(workspacePath);
  const checks = [];
  for (const check of requiredChecks) {
    checks.push(await runVerification({
      workspacePath,
      command: check.command,
      args: check.args ?? [],
      timeoutMs: check.timeoutMs ?? timeoutMs,
    }));
  }
  const fingerprintAfter = fingerprintWorkspace(workspacePath);
  const fingerprintDelta = fingerprintBefore ? diffFingerprints(fingerprintBefore, fingerprintAfter) : null;
  const failed = checks.filter((c) => !c.passed);

  return {
    workspacePath,
    collectedAt: new Date().toISOString(),
    git,
    checks,
    failedChecks: failed.map((c) => ({ command: c.command, exitCode: c.exitCode, failureReason: c.failureReason ?? null })),
    allChecksPassed: failed.length === 0,
    fingerprint: { count: fingerprintAfter.count, digest: fingerprintAfter.digest },
    fingerprintDelta,
  };
}
