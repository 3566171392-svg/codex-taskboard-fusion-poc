/**
 * Probe: does Codex's native `uncommittedChanges` review see the working tree
 * by itself — and is it genuinely read-only?
 *
 * This probe is deliberately independent of `src/core/evidence.mjs`: the module
 * whose responsibilities are under review must not be the tool that measures
 * them. Fingerprinting and git snapshotting are implemented locally here.
 *
 * What it establishes, with evidence rather than inference:
 *
 *   1. modified tracked file        -> reported by the reviewer?
 *   2. staged tracked file          -> reported by the reviewer?
 *   3. untracked file               -> reported by the reviewer?
 *   4. clean control file           -> wrongly reported as a change?
 *   5. real defect                  -> found without any diff summary or
 *                                      executor transcript?
 *   6. review lifecycle             -> enteredReviewMode / exitedReviewMode /
 *                                      turn/completed all observed?
 *   7. workspace mutation           -> git state, staged state, untracked set,
 *                                      HEAD, commits and content hashes
 *                                      unchanged across the review?
 *
 * The caller passes NO diff, NO file list, and NO hint about which defect
 * exists. Two review targets are compared so the difference between them is
 * measured rather than assumed:
 *
 *   mode=uncommittedChanges  target { type: "uncommittedChanges" }
 *                            pure Codex-native change enumeration
 *   mode=custom              target { type: "custom", instructions }
 *                            the v0.4 shape: task contract + acceptance
 *                            criteria + verdict contract, but still no diff and
 *                            no changed-file list
 *
 * The point of the comparison is the re-scoping question: if Codex enumerates
 * the working tree in both modes, Fusion does not need to build a diff or a
 * review scope for the reviewer — it only needs the channel that carries the
 * task's own contract and verdict requirement.
 *
 * Env:
 *   FUSION_POC_FIXTURE_ROOT     disposable workspace (default D:\poc\uncommitted-review-probe)
 *   FUSION_POC_MODEL            required
 *   FUSION_POC_MODEL_PROVIDER   default "custom"
 *   FUSION_POC_CODEX_HOME       default D:\poc\v2-codex-home
 *   FUSION_POC_TURN_TIMEOUT_MS  default 900000
 *   FUSION_POC_OUT              optional path to write the JSON report
 *   FUSION_POC_REVIEW_MODE      uncommittedChanges (default) | custom
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppServerStdio } from "../../src/adapters/app-server-stdio.mjs";

const root = process.env.FUSION_POC_FIXTURE_ROOT ?? "D:\\poc\\uncommitted-review-probe";
const model = process.env.FUSION_POC_MODEL;
const modelProvider = process.env.FUSION_POC_MODEL_PROVIDER ?? "custom";
const codexHome = process.env.FUSION_POC_CODEX_HOME ?? "D:\\poc\\v2-codex-home";
const timeoutMs = Number(process.env.FUSION_POC_TURN_TIMEOUT_MS ?? 900_000);
const outPath = process.env.FUSION_POC_OUT ?? null;
const mode = process.env.FUSION_POC_REVIEW_MODE ?? "uncommittedChanges";

if (!["uncommittedChanges", "custom"].includes(mode)) {
  console.error(`FUSION_POC_REVIEW_MODE must be uncommittedChanges or custom, got: ${mode}`);
  process.exit(2);
}

if (!model) {
  console.error("Set FUSION_POC_MODEL first.");
  process.exit(2);
}
if (!fs.existsSync(root) || !fs.existsSync(path.join(root, ".git"))) {
  console.error(`fixture is missing or not a git work tree: ${root}`);
  process.exit(2);
}

// Fail closed: an untrusted project makes the review refuse to read the tree,
// which would look like "the reviewer saw nothing" and be misread as a finding.
const configPath = path.join(codexHome, "config.toml");
if (!fs.existsSync(configPath)) {
  console.error(`CODEX_HOME has no config.toml: ${configPath}`);
  process.exit(2);
}
const trusted = fs.readFileSync(configPath, "utf8").toLowerCase().includes(`[projects.'${root.toLowerCase()}']`);
if (!trusted) {
  console.error(
    `workspace is not trusted in ${configPath}. Run scripts/trust-demo-workspace.mjs with ` +
    `FUSION_POC_CODEX_HOME and FUSION_POC_WORKSPACE set, then re-run. Refusing to run untrusted.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------- local tools
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch (error) {
    return `<git ${args.join(" ")} failed: ${error?.message ?? error}>`;
  }
};
const sha = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);

const SKIP_DIRS = new Set([".git", "node_modules"]);
function fingerprint(prefix = "") {
  const entries = [];
  const walk = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(childRel); continue; }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(path.join(root, childRel));
      entries.push({ path: childRel, bytes: bytes.length, hash: sha(bytes) });
    }
  };
  walk(prefix);
  return {
    count: entries.length,
    digest: sha(entries.map((e) => `${e.path}\t${e.bytes}\t${e.hash}`).join("\n")),
    files: entries.map((e) => `${e.path}\t${e.hash}`),
  };
}

/** Everything about the working tree that a mutation would have to disturb. */
function snapshot() {
  return {
    head: git("rev-parse", "HEAD"),
    commitCount: git("rev-list", "--count", "HEAD"),
    statusPorcelain: git("status", "--porcelain").split("\n").filter(Boolean),
    stagedHash: sha(git("diff", "--cached", "--binary")),
    unstagedHash: sha(git("diff", "--binary")),
    untracked: git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
    stash: git("stash", "list").split("\n").filter(Boolean),
    fingerprint: fingerprint(),
  };
}

const before = snapshot();
/**
 * The custom-target instruction, in the v0.4 shape: the task's own contract,
 * its acceptance criteria, and the verdict requirement. Deliberately carries no
 * diff, no changed-file list, and no review scope — the reviewer has to
 * determine what changed the same way Codex's own review does.
 */
const customInstructions = [
  "You are an independent reviewer on a separate read-only Codex thread.",
  "You cannot modify files, create commits, or change any state.",
  "Inspect the real workspace yourself, including its uncommitted changes.",
  "Do not trust any summary of it — including this message.",
  "",
  `Workspace: ${root}`,
  "",
  "TASK CONTRACT:",
  JSON.stringify({
    title: "Make the working tree consistent with its documented contracts",
    description:
      "The uncommitted changes in this repository contradict the contracts " +
      "documented in the files they touch. Review the working tree — staged, " +
      "unstaged and untracked alike — and report every substantiated defect.",
  }, null, 2),
  "",
  "ACCEPTANCE CRITERIA:",
  "- Every modified file must satisfy the contract stated in its own docstring.",
  "- A staged change must not introduce a regression.",
  "- A newly added file that its own test contradicts is a defect.",
  "- Unchanged files are not part of the change set and must not be reported as changes.",
  "",
  "Report every defect you can substantiate from the actual files.",
  "End your final message with exactly one line:",
  "VERDICT: PASS    (only if you found no real defect, or you found none that is in scope)",
  "VERDICT: FAIL    (if any in-scope defect remains)",
  "Emit exactly one of those two lines and nothing after it.",
].join("\n");

const reviewTarget = mode === "custom"
  ? { type: "custom", instructions: customInstructions }
  : { type: "uncommittedChanges" };

const report = {
  root,
  model,
  modelProvider,
  codexHome,
  mode,
  reviewTarget: reviewTarget.type === "custom"
    ? { type: "custom", instructionsLength: reviewTarget.instructions.length }
    : reviewTarget,
  reviewDelivery: "inline",
  callerSuppliedToReviewer: {
    diff: null,
    changedFileList: null,
    reviewScope: null,
    defectHint: null,
    note: `review/start target.type=${reviewTarget.type}; the caller supplies no diff, no changed-file list and no review scope`,
  },
  workspaceBefore: before,
};

// ---------------------------------------------------------------- the review
const server = new AppServerStdio({ cwd: root, timeoutMs: 120_000, env: { CODEX_HOME: codexHome } });

try {
  await server.start();

  const reviewer = await server.startThread({
    cwd: root, model, modelProvider, sandbox: "read-only",
  });
  const reviewerThreadId = reviewer?.thread?.id ?? null;
  if (!reviewerThreadId) throw new Error("reviewer thread/start returned no thread id");

  // A second, unused thread purely to prove the reviewer is independent of any
  // other thread rather than inheriting one.
  const other = await server.startThread({ cwd: root, model, modelProvider, sandbox: "read-only" });
  const otherThreadId = other?.thread?.id ?? null;

  report.reviewer = {
    threadId: reviewerThreadId,
    sandbox: reviewer?.sandbox?.type ?? null,
    historyMode: reviewer?.thread?.historyMode ?? null,
    cwd: reviewer?.cwd ?? null,
    distinctFromOtherThread: reviewerThreadId !== otherThreadId,
  };

  const started = await server.startReview({
    threadId: reviewerThreadId,
    target: reviewTarget,
    delivery: "inline",
  });
  report.reviewStart = {
    reviewThreadId: started?.reviewThreadId ?? null,
    turnId: started?.turn?.id ?? null,
    responseKeys: started && typeof started === "object" ? Object.keys(started).sort() : null,
  };
  if (!report.reviewStart.turnId) throw new Error("review/start returned no turn id");

  const completed = await server.waitForReview({
    threadId: reviewerThreadId, turnId: report.reviewStart.turnId, timeoutMs,
  });

  const itemTypes = completed.items.map((item) => item.type);
  const reviewModeItems = completed.items
    .filter((item) => item.type === "enteredReviewMode" || item.type === "exitedReviewMode")
    .map((item) => ({ type: item.type, review: String(item.review ?? "") }));

  // The lifecycle also arrives as notifications; record the exact methods so
  // "entered: 2" is explained by evidence rather than left as a bare number.
  const lifecycleNotifications = completed.notifications
    .filter((n) => {
      const t = n?.params?.item?.type;
      return t === "enteredReviewMode" || t === "exitedReviewMode";
    })
    .map((n) => ({ method: n.method, itemType: n.params?.item?.type, turnId: n.params?.turnId ?? null }));

  report.reviewResult = {
    turnId: completed.turnId,
    turnStatus: completed.status,
    turnError: completed.error ?? null,
    lifecycleFromEvents: completed.reviewMode,
    lifecycleNotifications,
    itemTypes,
    enteredReviewModeItems: reviewModeItems.filter((i) => i.type === "enteredReviewMode").length,
    exitedReviewModeItems: reviewModeItems.filter((i) => i.type === "exitedReviewMode").length,
    reviewTextLength: completed.review?.length ?? 0,
    reviewText: completed.review ?? null,
    notificationCount: completed.notifications.length,
    timeoutsObserved: completed.notifications.filter((n) => n.method === "turn/interrupted").length,
  };

  // A reviewer's own account of what it changed is unverifiable; the snapshot is.
  const after = snapshot();
  report.workspaceAfter = after;
  report.mutation = {
    headUnchanged: before.head === after.head,
    commitCountUnchanged: before.commitCount === after.commitCount,
    stagedUnchanged: before.stagedHash === after.stagedHash,
    unstagedUnchanged: before.unstagedHash === after.unstagedHash,
    untrackedUnchanged: JSON.stringify(before.untracked) === JSON.stringify(after.untracked),
    stashUnchanged: JSON.stringify(before.stash) === JSON.stringify(after.stash),
    contentDigestUnchanged: before.fingerprint.digest === after.fingerprint.digest,
    fileCountUnchanged: before.fingerprint.count === after.fingerprint.count,
    addedFiles: after.fingerprint.files
      .filter((f) => !before.fingerprint.files.includes(f)).map((f) => f.split("\t")[0]),
    removedFiles: before.fingerprint.files
      .filter((f) => !after.fingerprint.files.includes(f)).map((f) => f.split("\t")[0]),
  };
} catch (error) {
  report.error = String(error);
} finally {
  report.stderrTail = String(server.lastStderr ?? "").split("\n").slice(-5).join("\n");
  await server.stop();
}

const text = report.reviewResult?.reviewText ?? "";
const mentions = (needle) => text.toLowerCase().includes(needle.toLowerCase());
report.coverage = {
  mentionsModifiedTrackedFile: mentions("config.js"),
  mentionsStagedTrackedFile: mentions("format.js"),
  mentionsUntrackedFile: mentions("example.js"),
  mentionsCleanControlFile: mentions("stable.js"),
  mentionsReadmeControl: mentions("readme"),
  mentionsDivideDefect: mentions("divide"),
  mentionsRetriesDefect: mentions("retries"),
  mentionsTrimDefect: mentions("trim"),
};
// The verdict contract is the Fusion-owned part of the review channel. The
// native `uncommittedChanges` target has no way to carry it, so this records
// whether the mode actually produced a marker.
report.verdictContract = {
  emittedPassMarker: /^VERDICT:\s*PASS$/im.test(text),
  emittedFailMarker: /^VERDICT:\s*FAIL$/im.test(text),
  markerLineIsFinalLine: (() => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return /^VERDICT:\s*(PASS|FAIL)$/i.test(lines.at(-1) ?? "");
  })(),
};
report.io = (() => {
  const lines = text.split(/\r?\n/).filter(Boolean).length;
  const encoded = Buffer.byteLength(JSON.stringify(report), "utf8");
  return { reviewTextLines: lines, reportBytes: encoded };
})();

const json = JSON.stringify(report, null, 2);
if (outPath) fs.writeFileSync(outPath, json, "utf8");
console.log(json);
