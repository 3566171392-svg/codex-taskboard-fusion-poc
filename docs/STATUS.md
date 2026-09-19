# STATUS v0.4 — Codex-native Review Gate MVP

## What this revision does

The reviewer no longer depends on `turn/start.outputSchema`. It runs Codex's own
review machinery: a fresh read-only reviewer thread plus native `review/start`
with inline delivery. The verdict travels as one explicit line
(`VERDICT: PASS` / `VERDICT: FAIL`) and is combined with machine evidence.

## Verified locally

| Command | Exit | Result |
| --- | --- | --- |
| `npm test` | 0 | 40 tests, 0 fail |
| `npm run lint` | 0 | all sources and scripts parse |
| `npm run demo` | 0 | FAIL -> same executor -> new reviewer -> PASS, `READY_FOR_ACCEPTANCE`, `autoCompleted: false` |

## Verified on this Windows machine (real app-server + real model)

`npm run live-native-review` (target `uncommittedChanges`):

```json
{
  "reviewerIsIndependent": true,
  "reviewerSandbox": "readOnly",
  "turnStatus": "completed",
  "reviewMode": { "entered": 2, "exited": 2 },
  "detachedRefusedByAdapter": "review/start delivery \"detached\" is not supported by this POC"
}
```

`entered` / `exited` arrive as two notifications each (`item/started` and
`item/completed`), so a **single** review turn reports `2 / 2`. The count is
lifecycle events, not reviews; the Gate's threshold (`>= 1`) is the correct one.

## Native review scope and reviewer sandbox (probed, not assumed)

`scripts/v0.4-probes/` measured two questions this architecture depends on.
Full findings and their limits: `docs/RESEARCH-NATIVE-REVIEW-SCOPE.md`.

| Question | Measurement |
| --- | --- |
| Does Codex enumerate the working tree itself? | Yes, for both `target: uncommittedChanges` and `target: custom`. Modified, staged and untracked changes were all found, and a clean control file was explicitly listed as *unchanged, not a change*. |
| Does the caller need to supply a diff or a changed-file list? | No. Nothing was supplied; the reviewer ran the repo's own test command and found all three planted defects from the files alone. |
| Can `uncommittedChanges` carry the verdict? | No. It emitted no `VERDICT:` marker at all, ending with a prose question. `custom` emitted `VERDICT: FAIL` as its final line. `custom` remains the only channel that carries both the task contract and the verdict marker. |
| Is `read-only` enforced during a native review? | Yes. Ordered to create a file, overwrite a tracked file, delete a tracked file and commit: nothing changed under `read-only`, while `workspace-write` on an identical repo created and overwrote files. Refusals were `UnauthorizedAccessException` / `Permission denied` / `.git/index.lock: Permission denied`. |
| Does the reviewer write to git? | No commits under either sandbox — `.git` is protected independently of the thread sandbox. |

Consequences, none of which change the Gate:

- `custom` target stays; it is a limitation of this build, not a preference.
- `read-only` + fail-closed stays as a PASS condition; it is load-bearing.
- No Fusion-side diff generation or review-scope construction was added, because
  Codex already covers it. `reviewScope` remains an optional narrowing hint.
- Git state and the workspace fingerprint stay as provenance for the durable
  attempt record. They are **not** verdict inputs: the only evidence fields that
  can change a verdict are `identityMatches` and `allChecksPassed`.

`npm run live-gate-demo` (full Gate, real workspace with a real defect):

| Observation | Value |
| --- | --- |
| Executor thread | `01a0b9ba-bfc6-7f22-a7e5-7e7e920ae57a`, sandbox `workspaceWrite` |
| Reviewer B / C | `01a0b9ba-c0d0-…`, `01a0b9bb-61f2-…` — both distinct from A and from each other |
| Review attempt 1 | real failing test (`exitCode: 1`), reviewer marker `VERDICT: FAIL` -> FAIL |
| Executor repair | same thread A, real fix to `src/geometry.js` |
| Review attempt 2 | tests pass (`exitCode: 0`), reviewer marker `VERDICT: PASS` -> PASS |
| Final gate | `READY_FOR_ACCEPTANCE`, task `in_review` |
| Auto-completed | **false** |

Independent ground truth, read off disk after the run: `node --test` exit 0,
5/5 tests pass, the test file is unchanged from the fixture, and no files were
added.

## Gate verdicts

| Verdict | Produced by |
| --- | --- |
| PASS | independent read-only reviewer + review turn completed + lifecycle observed + exactly one `VERDICT: PASS` + machine checks passed + identity matched |
| FAIL | a `VERDICT: FAIL`, or failing machine verification (checked first, so failing tests always reach the executor) |
| BLOCKED | reviewer not independent / not read-only, turn aborted, lifecycle missing, no verdict or an ambiguous one, identity mismatch, notification history lost, attempts exhausted |

## Not verified here

- Production acceptance semantics in dashi: the Gate stops at `in_review` and
  human acceptance is a separate, explicit call.
- Reviewer and executor on *different* providers: the local provider proxy has no
  per-thread routing, so both currently share one upstream. This MVP does not
  require it, and the Gate treats the reviewer's model as unobserved.
- `turn/start.outputSchema` enforcement. Measured on this build: the schema is
  accepted and forwarded but not enforced on the tested provider route, so the
  Gate does not depend on it. See `docs/LIVE-VERIFICATION-V0.3-WINDOWS.md`.
