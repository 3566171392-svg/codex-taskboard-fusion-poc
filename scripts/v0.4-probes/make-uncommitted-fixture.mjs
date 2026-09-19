/**
 * Build the disposable git workspace for the native `uncommittedChanges`
 * review probe.
 *
 * The fixture exists to answer one question with evidence: when Fusion asks
 * Codex for a native review of `{ type: "uncommittedChanges" }`, does Codex
 * itself enumerate the working tree (modified / staged / untracked) — or does
 * Fusion still have to produce a diff, a file list, or a review scope?
 *
 * The working tree therefore contains deliberately distinct kinds of change:
 *
 *   modified tracked   src/config.js   `retries = 5` breaks its own contract
 *   staged tracked     src/format.js   drops the documented trim()
 *   untracked          src/example.js  `divide` returns Infinity for a zero
 *                                      divisor instead of throwing
 *   untracked          test/example.test.js  asserts the documented contract
 *   clean tracked      src/stable.js   control: must not be reported as a change
 *   clean tracked      README.md       control
 *
 * Each defect contradicts a docstring in the same file, so a reviewer can
 * substantiate it from the files alone — no executor transcript, no diff
 * summary, no hint from the caller.
 *
 * Only writes inside FUSION_POC_FIXTURE_ROOT (default
 * D:\poc\uncommitted-review-probe).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.FUSION_POC_FIXTURE_ROOT ?? "D:\\poc\\uncommitted-review-probe";
if (!path.win32.isAbsolute(root) || !root.toLowerCase().startsWith("d:\\poc\\")) {
  console.error(`refusing to write outside D:\\poc: ${root}`);
  process.exit(2);
}

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.join(root, "src"), { recursive: true });
await fs.mkdir(path.join(root, "test"), { recursive: true });

const write = (rel, body) => fs.writeFile(path.join(root, rel), body, "utf8");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// ---------------------------------------------------------------- baseline
await write("README.md", [
  "# probe-fixture",
  "",
  "Disposable workspace for the native `uncommittedChanges` review probe.",
  "Committed files are the baseline; the working tree carries the changes.",
  "",
].join("\n"));

await write("package.json", JSON.stringify({
  name: "uncommitted-review-probe",
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: { test: "node --test" },
}, null, 2) + "\n");

// Control: committed and deliberately left untouched.
await write("src/stable.js", [
  "/**",
  " * Untouched helper.",
  " *",
  " * This file is committed and left unmodified on purpose: it is the control",
  " * for the probe. A reviewer that reports it as a change is wrong.",
  " */",
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
].join("\n"));

// Will be modified (unstaged) so `retries` breaks its own contract.
await write("src/config.js", [
  "/**",
  " * Retry policy.",
  " *",
  " * Contract: the upstream accepts at most MAX_RETRIES attempts. `retries`",
  " * must never exceed MAX_RETRIES.",
  " */",
  "export const MAX_RETRIES = 3;",
  "export const retries = 3;",
  "",
  "export function clampRetries(value) {",
  "  return Math.min(value, MAX_RETRIES);",
  "}",
  "",
].join("\n"));

// Will be staged with a change that drops the documented trim().
await write("src/format.js", [
  "/**",
  " * Label formatting.",
  " *",
  " * Contract: `formatLabel` must return the label with surrounding whitespace",
  " * removed. Callers compare the result against exact strings.",
  " */",
  "export function formatLabel(name) {",
  "  return name.trim();",
  "}",
  "",
].join("\n"));

git("init", "--quiet");
git("config", "user.email", "probe@example.invalid");
git("config", "user.name", "Review Probe");
git("config", "commit.gpgsign", "false");
git("add", "-A");
git("commit", "--quiet", "-m", "baseline");
const baselineHead = git("rev-parse", "HEAD");

// ---------------------------------------------------- 1. modified tracked
await write("src/config.js", [
  "/**",
  " * Retry policy.",
  " *",
  " * Contract: the upstream accepts at most MAX_RETRIES attempts. `retries`",
  " * must never exceed MAX_RETRIES.",
  " */",
  "export const MAX_RETRIES = 3;",
  "export const retries = 5;",
  "",
  "export function clampRetries(value) {",
  "  return Math.min(value, MAX_RETRIES);",
  "}",
  "",
].join("\n"));

// ------------------------------------------------------ 2. staged tracked
await write("src/format.js", [
  "/**",
  " * Label formatting.",
  " *",
  " * Contract: `formatLabel` must return the label with surrounding whitespace",
  " * removed. Callers compare the result against exact strings.",
  " */",
  "export function formatLabel(name) {",
  "  return name;",
  "}",
  "",
].join("\n"));
git("add", "src/format.js");

// ----------------------------------------------------------- 3. untracked
await write("src/example.js", [
  "/**",
  " * Arithmetic helpers.",
  " *",
  " * Contract: `divide` must reject a zero divisor by throwing a RangeError.",
  " * Returning Infinity would silently poison downstream calculations.",
  " */",
  "export function divide(a, b) {",
  "  return a / b;",
  "}",
  "",
].join("\n"));

await write("test/example.test.js", [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'import { divide } from "../src/example.js";',
  "",
  'test("divide rejects a zero divisor", () => {',
  "  assert.throws(() => divide(10, 0), RangeError);",
  "});",
  "",
  'test("divide still divides normally", () => {',
  "  assert.equal(divide(10, 2), 5);",
  "});",
  "",
].join("\n"));

// --------------------------------------------------------------- report
const porcelain = git("status", "--porcelain");
const summary = {
  root,
  baselineHead,
  head: git("rev-parse", "HEAD"),
  unbornCommits: git("rev-list", "--count", "HEAD"),
  statusPorcelain: porcelain.split("\n").filter(Boolean),
  stagedFiles: git("diff", "--cached", "--name-status").split("\n").filter(Boolean),
  unstagedFiles: git("diff", "--name-status").split("\n").filter(Boolean),
  untrackedFiles: git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
  cleanControlFiles: ["README.md", "package.json", "src/stable.js"],
  expectedDefects: [
    "src/config.js: retries = 5 contradicts MAX_RETRIES = 3",
    "src/format.js (staged): formatLabel no longer trims",
    "src/example.js (untracked): divide returns Infinity instead of throwing RangeError",
  ],
};

console.log(JSON.stringify(summary, null, 2));
