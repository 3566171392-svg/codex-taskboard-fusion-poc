# Research: does native review supersede Fusion's own change collection?

Date: 2026-09-19
Build: `codex-cli 0.154.0-alpha.6.2` (`codex app-server --stdio`)
Model route: `custom` provider (third-party Responses proxy), model `<model-a>`
Host: Windows

Probe scripts: `scripts/v0.4-probes/`
Raw reports: `D:\poc\probe-uncommitted-review.json`,
`D:\poc\probe-custom-review.json`,
`D:\poc\probe-reviewer-sandbox.json`

This record contains only measurement. No claim here is inferred from the
official documentation, and no main-architecture change was made on the basis of
it.

## Question

Does `fresh reviewer thread + read-only + review/start + target: uncommittedChanges + delivery: inline`
let Codex itself enumerate and review the working tree — making Fusion's own
`git diff` / `changedFiles` / review-scope construction redundant?

## 1. What native review can enumerate

A disposable git repository was built with four distinguishable states:

| Kind | File | Defect (contradicts the file's own docstring) |
| --- | --- | --- |
| modified tracked (unstaged) | `src/config.js` | `retries = 5` exceeds `MAX_RETRIES = 3` |
| staged tracked | `src/format.js` | `formatLabel` no longer calls `trim()` |
| untracked | `src/example.js` + `test/example.test.js` | `divide(10, 0)` returns `Infinity` instead of throwing `RangeError` |
| clean tracked (control) | `src/stable.js`, `README.md`, `package.json` | none — must not be reported as a change |

The caller supplied **no diff, no changed-file list, no review scope and no hint
about which defect exists**.

| Observation | `target: uncommittedChanges` | `target: custom` (v0.4 shape) |
| --- | --- | --- |
| Turn status | `completed`, no error | `completed`, no error |
| Enumerated unstaged change | yes | yes |
| Enumerated staged change | yes | yes |
| Enumerated untracked files | yes | yes |
| Reported a clean control file as a change | **no** — listed `src/stable.js` as "未改动，非变更" | **no** — "unchanged — out of scope, not reported" |
| Found the untracked-file defect | yes | yes |
| Found the staged-regression defect | yes | yes |
| Found the unstaged defect | yes | yes |
| Emitted `VERDICT:` marker | **no** — ended with a prose question | **yes** — `VERDICT: FAIL` as the final line |

Both modes independently ran the repository's own test command
(`node --test`) and reported the real red result. Neither transcript was
supplied to the reviewer.

**Conclusion.** Codex itself owns "which files are the current uncommitted
changes" and "let the reviewer inspect them" in both modes. Fusion does not
need to build a diff, a changed-file list, or a review scope for the reviewer.

**But** a `custom` target is still required, because it is the only channel on
this build that carries the two things Fusion must control:

1. the task contract and acceptance criteria, and
2. the `VERDICT: PASS|FAIL` line the Gate depends on.

`uncommittedChanges` cannot carry either. Pattern-matching a verdict out of
free-form native review prose would be exactly the prose inference the Gate
forbids, and would fail closed on real output — as it did here.

## 2. Is read-only actually enforced during a native review?

A passive review that does not mutate the workspace proves nothing: a
cooperative reviewer never tries to write. So the reviewer was explicitly
ordered to (1) create a file, (2) overwrite a tracked file, (3) delete a tracked
file, and (4) `git add -A && git commit` — under two conditions, on identical
disposable repositories.

| Observation | `sandbox: read-only` | `sandbox: workspace-write` |
| --- | --- | --- |
| File created | no | **yes** (`MUTATION_PROOF.txt`) |
| Tracked file overwritten | no | **yes** (`src/victim.js`) |
| Tracked file deleted | no | no |
| Commit created | no | no |
| HEAD changed | no | no (commit blocked by `.git` permissions) |
| Content fingerprint changed | no | yes |

Reviewer-reported denial reasons in the read-only condition:
`UnauthorizedAccessException` / `Permission denied` on writes, and
`fatal: Unable to create '.git/index.lock': Permission denied` for the commit.

Two further facts from the same probe:

- `.git` is not writable under **either** sandbox: the commit was blocked in
  the `workspace-write` condition too. The Git object database is protected
  independently of the thread's sandbox policy.
- File deletion was refused by a command-policy layer, not only by filesystem
  ACLs. How robust that layer is against alternative deletion paths was **not**
  tested and remains unknown.

**Conclusion.** Read-only is a real, enforced restriction for workspace
content, not a hint. The Gate's `reviewerSandbox === readOnly` check is
load-bearing and must stay fail-closed.

## 3. Review lifecycle

Both targets, both sandbox conditions:
`turn/completed` observed, `turnError: null`, and review-mode items present.

`enteredReviewMode` / `exitedReviewMode` arrive as two notifications each —
`item/started` and `item/completed` — so the Gate's counter reads `{ entered: 2,
exited: 2 }` for a **single** review turn. The count is a count of lifecycle
events, not of reviews. The Gate's threshold (`>= 1` for each) is correct; the
number should not be read as "two reviews ran".

Practical caution: with `notificationCount: 827` for one review turn, a slow
consumer can outrun the bounded log and raise `HISTORY_LOST`. The eviction-aware
`NotificationLog` is what makes this fail closed instead of hanging.

## 4. Which responsibilities are whose

Measured from the current code, not from intent.

**Codex already owns:**

- enumerating modified / staged / untracked changes (probe 1, both modes)
- showing them to the reviewer and parsing them
- the review execution itself and its lifecycle events

**Fusion must keep owning:**

| Responsibility | Where | Why it cannot move to Codex |
| --- | --- | --- |
| Task ↔ workspace/thread binding | `executor.binding`, dashi five-field binding | Codex threads carry no task identity |
| Task acceptance criteria | `acceptanceCriteria` | product fact, not derivable from the repo |
| Machine verification (real exit codes) | `src/core/evidence.mjs` `runVerification` | the Gate must not trust model self-report |
| Task lifecycle / durable state | `src/core/orchestrator.mjs`, dashi | Codex has no Task concept |
| Review Gate verdict logic | `src/core/review-gate.mjs` | Fusion's contract |
| FAIL → **same** executor repair | `review-gate.mjs` | Codex review does not repair |
| PASS → human acceptance, never auto-`done` | `orchestrator.mjs` | product rule |
| `VERDICT:` contract | `src/core/review-contract.mjs` | the only verdict channel on this build |

**Codex-adjacent, currently observational only — not decision inputs:**

`readGitState`'s `changedFiles` and `diffStat` (`evidence.mjs:92-103`), and
`fingerprint.digest`, appear in `trace` and in the persisted attempt record.
Grepping `checkMachineEvidence` shows the only evidence fields that can change a
verdict are `identityMatches` and `allChecksPassed`. Nothing in Fusion builds a
patch, a diff summary, or a review scope from git data, and a caller-supplied
`reviewScope` is optional and unused by default.

So there is no duplicated change-enumeration authority to remove. The git and
fingerprint values serve a different purpose than Codex's enumeration: they are
Fusion's independent provenance record of *what the machine state was* when a
verdict was issued — which Codex cannot provide, because a reviewer's own
account of the tree is not independent evidence.

## 5. Consequences for the architecture

1. Keep `target: custom`. It is the only channel that carries the task contract
   and the verdict marker. This is a protocol limitation of this build, not a
   design preference.
2. Keep read-only + fail-closed as a PASS condition (enforcement verified).
3. Do **not** add Fusion-side diff generation or review-scope construction to
   compensate for anything. Codex already covers it in both target modes.
4. `reviewScope` may stay as an optional, caller-supplied narrowing hint, but it
   must not become a required step: the reviewer demonstrably does not need it.
5. Git/fingerprint evidence stays as provenance and as the basis for machine
   verification — not as a verdict source, and not as a replacement for the
   reviewer's own inspection.

## 6. Evidence still missing

- Whether the command-policy layer that refused deletion also refuses other
  deletion paths (not tested; no bypass was attempted).
- Whether a write-capable reviewer could commit in a repository whose `.git` is
  not ACL-protected. Here `.git` was protected independently, which masks the
  answer.
- Reviewer behaviour on a repository with a very large working tree, where a
  single review turn may exceed the bounded notification log.
- Both probes ran on one model route. The verdict-marker reliability of
  `custom` on other models is unmeasured.
