# STATUS v0.4 — Codex-native Review Gate MVP

## What this revision does

The reviewer no longer depends on `turn/start.outputSchema`. It runs Codex's own
review machinery: a fresh read-only reviewer thread plus native `review/start`
with inline delivery. The verdict travels as one explicit line
(`VERDICT: PASS` / `VERDICT: FAIL`) and is combined with machine evidence.

## Verified locally

| Command | Exit | Result |
| --- | --- | --- |
| `npm test` | 0 | 79 tests, 0 fail |
| `npm run lint` | 0 | all sources and scripts parse |
| `npm run demo` | 0 | FAIL -> same executor -> new reviewer -> PASS, `READY_FOR_ACCEPTANCE`, `autoCompleted: false` |

## Correctness pass: three checks that were not actually firing

This revision fixed three places where the Gate looked stricter than it was.
None of them was a research question; each was a defect with a failing test.

| Defect | Evidence | Fix |
| --- | --- | --- |
| Any unknown status resolved to `run`. The mapping ended in `else action = "run"`, so `backlog` and `canceled` both started executing. | `backlog` is not approved for execution in dashi's own rules; an assignee alone is not authorization. | Explicit `RUNNABLE_STATES`; every other status maps to a stop action, and an unrecognized status is `unknown_status`. |
| `identityMatches` was a PASS condition that nothing ever produced, and was tested as `=== false`. | Evidence that omitted the field passed by omission, so the check never fired. | Real server-observed identity (below), requiring exactly `true`. |
| A repeated `VERDICT:` marker was accepted, last one winning. | `VERDICT: PASS … VERDICT: PASS` returned PASS; so did contradictory output resolved by position. | Duplicate markers are BLOCKED. Only exactly one marker yields a verdict. |

## The verdict contract is fail-closed

| Reviewer output | Verdict |
| --- | --- |
| exactly one `VERDICT: PASS` | PASS candidate |
| exactly one `VERDICT: FAIL` | FAIL |
| no marker | BLOCKED |
| `PASS` and `FAIL` together | BLOCKED |
| the same marker twice | BLOCKED |

## Identity evidence, from the App Server

`core/evidence.mjs::collectIdentityEvidence` verifies the binding against what
the server reports for the bound thread, so a PASS cannot rest on a value Fusion
stored itself. Measured on this machine:

```json
{
  "expectedWorkspace": "D:\\poc\\uncommitted-review-probe",
  "observedCwd":       "D:\\poc\\uncommitted-review-probe",
  "observedThreadId":  "<same as the binding>",
  "identityMatches": true,
  "source": "thread/read (app server)"
}
```

Negative controls, all fail-closed: a different workspace, a foreign thread id
(`-32600 thread not loaded`), and a binding with no thread id.

## Restart and resume — real, on dashi

`scripts/live-dashi-e2e.mjs` runs the real thing. Results from this machine:

| Scenario | Result |
| --- | --- |
| Fresh run | Executor A -> machine evidence `exitCode 1` -> Reviewer B `VERDICT: FAIL` -> A repairs -> machine evidence `exitCode 0` -> Reviewer C `VERDICT: PASS` -> `in_review` |
| Crash before repair | Process exited inside `repair()`; workspace untouched (`git status` clean) |
| Resume | New process: `thread/resume(A)` -> repair on the same A -> C passes. `threadIdUnchanged: true`, attempts continued 1 -> 2 -> 3 |
| Restart while `in_review` | New process: `await_human`, `attemptedWork: false`, **zero** app-server calls |
| Restart while `blocked` | Stays `blocked`, `attemptedWork: false`, zero app-server calls |
| Backlog / canceled on real dashi | `not_approved` / `canceled`, zero app-server calls, task and version unchanged |

One real defect surfaced only here and is fixed: the first run of a brand-new
task called `thread/resume` on a thread that had not run a turn yet, and the
server rejected it with `-32600 no rollout found`, blocking the task before any
work. A first run has no durable attempt history, so it must not resume.

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
| PASS | independent read-only reviewer + review turn completed + lifecycle observed + exactly one `VERDICT: PASS` + machine checks passed + identity established |
| FAIL | exactly one `VERDICT: FAIL`, or failing machine verification (checked first, so failing tests always reach the executor) |
| BLOCKED | reviewer not independent / not read-only, turn aborted or errored, lifecycle missing, no verdict / both markers / a repeated marker, identity not established, notification history lost, attempt budget exhausted, executor thread could not be resumed |

## Not verified here

- Reviewer and executor on *different* providers: the local provider proxy has
  no per-thread routing, so both currently share one upstream. This MVP does not
  require it, and the Gate treats the reviewer's model as unobserved.
- Production acceptance semantics in dashi: human acceptance is modelled as a
  versioned move to `done` behind an explicit call, and `acceptTask` refuses
  unless the task is `in_review` with a PASS verdict. That is a POC-level
  convention, not a dashi workflow guarantee.
- `thread/resume` for an executor thread whose rollout has been pruned, and
  resuming a thread while another process holds it.
