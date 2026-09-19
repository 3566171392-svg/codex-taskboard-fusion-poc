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
