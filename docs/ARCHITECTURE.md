# Architecture v0.4 — Codex-native Review Gate MVP

## Decision

The Reviewer runs Codex's own review machinery on a separate read-only thread:

```text
Taskboard task
    |
    v
Executor Thread A                (workspace-write)
    |  implementation
    |  machine evidence: real tests + git state + workspace fingerprint
    v
fresh Reviewer Thread B          (read-only, cwd = executor workspace)
    |  native review/start { delivery: "inline", target: { type: "custom", instructions } }
    v
review lifecycle: enteredReviewMode -> exitedReviewMode -> turn/completed
    |
    v
Thin Review Gate
    Layer A  reviewer completed normally
    Layer B  explicit verdict marker in the review body
    Layer C  machine evidence
    |
    +--> PASS     -> in_review, READY_FOR_ACCEPTANCE (human acceptance still required)
    +--> FAIL     -> todo -> in_progress -> Thread A repairs -> new Reviewer Thread C
    +--> BLOCKED  -> blocked
```

### What changed from v0.3, and why

v0.3 required schema-constrained JSON from `turn/start.outputSchema`. That made
the Gate depend on a provider capability that is not guaranteed: it was measured
absent on the local provider proxy → third-party route, so the Gate could not reach PASS
without a specific upstream. The MVP removes that dependency.

The verdict now travels through Codex's own review lifecycle, and the contract
the reviewer must satisfy is a single line of text:

```text
VERDICT: PASS
VERDICT: FAIL
```

No JSON schema, no structured-output provider requirement.

### Why not `review/start` with `delivery: "detached"`

Measured on this build and rejected:

1. Refused on paginated threads: `-32600 paginated threads do not support
   detached review`; a plain `thread/start` returns `historyMode: "paginated"`.
2. Deprecated by Codex; every call emits a `deprecationNotice`.
3. It runs an agent invocation rather than the review task, so it never emits
   `enteredReviewMode` / `exitedReviewMode`.

`AppServerStdio.startReview` therefore accepts only `delivery: "inline"` and
throws for anything else, so the deprecated path cannot be reached by accident.
The independent-thread requirement is met by creating a *separate* reviewer
thread before the review, not by detached delivery.

### Verdict layers

| Layer | Checks | Failure |
| --- | --- | --- |
| A. Reviewer completion | reviewer thread exists, is not the executor thread, sandbox is read-only, review turn status `completed`, no turn error, review lifecycle observed | BLOCKED |
| B. Verdict extraction | exactly one `VERDICT: PASS` or `VERDICT: FAIL` line. No marker, both markers, or a repeated marker is ambiguous | BLOCKED |
| C. Machine evidence | required verification commands pass, workspace identity is **established**, no notification history loss | FAIL when a check fails, BLOCKED on identity/history problems |

Machine evidence is evaluated **before** the reviewer's opinion, so failing
tests always reach the executor instead of stalling as BLOCKED. A PASS needs
both the marker and passing machine evidence; prose alone is never a PASS.

### Identity evidence is server-observed, and fails closed

Layer C checks `identityMatches`, so that field needs a real source. An earlier
revision checked it while nothing produced it, and tested only
`identityMatches === false` — so evidence that simply omitted the field passed by
omission, and the check never fired.

The Gate now collects it itself, from the App Server's own view of the bound
thread (`thread/read`), and requires all of:

1. the bound thread still exists and reports that same id,
2. the server reports a `cwd` for it,
3. that `cwd` is the workspace the binding claims, and
4. that workspace is the one the evidence was collected from.

`identityMatches` must be exactly `true`; `false`, missing, or unobservable are
all BLOCKED. Paths are normalized for case and separators before comparison, so
different spellings of the same location match while different locations never
can.

### Task status decides whether work may start at all

Only `todo`, `in_progress` and `todo` (review-rejected) are runnable. Everything
else fails closed:

| Task status | Resume action |
| --- | --- |
| `todo`, `in_progress`, review-rejected | `run` |
| `in_review` | `await_human` |
| `backlog` | `not_approved` — dashi treats backlog as not approved for execution |
| `blocked` | `blocked` |
| `done` | `done` |
| `canceled` | `canceled` |
| anything unrecognized | `unknown_status` |

The earlier mapping ended in `else action = "run"`, so `backlog`, `canceled` and
any unknown status all fell through to "start executing".

### Restart semantics

Fusion stores only `task -> executorThreadId`. It does not replay a transcript
and does not rebuild Codex context: on restart it calls `thread/resume` and the
conversation history stays with Codex.

- A restart is identified by **durable attempt history**, not by status. A first
  run has no attempts and its thread was just created, so nothing is resumed —
  resuming a thread that has not run a turn fails with `-32600 no rollout found`.
- An executor that presents a different thread than the task is bound to is a
  conflict, refused rather than silently merged.
- A failed `thread/resume` blocks the task; it never falls back to a fresh thread.
- Attempt numbering continues from the durable records, so a restart cannot
  refresh the `maxAttempts` budget or produce two records numbered `attempt: 1`.

## Thin Gate responsibilities

The POC owns only:

1. Taskboard state transition into `in_review`.
2. Executor identity validation.
3. Creating the independent read-only Reviewer thread.
4. Verifying `reviewerThreadId !== executorThreadId` and `sandbox = read-only`.
5. Waiting for the reviewer turn to complete via a sequence-addressed log.
6. Validating the response against the review contract.
7. Combining reviewer verdict with deterministic test/evidence signals.
8. FAIL -> the *same* Executor thread repairs; the next attempt uses a *new*
   Reviewer thread.
9. PASS -> `in_review` / human acceptance, never automatic `done`.
10. BLOCKED for ambiguous, unsafe, or unsupported conditions.

## Gate verdicts

```text
PASS     independent reviewer thread + read-only sandbox + turn completed
         + lifecycle observed + exactly one `VERDICT: PASS`
         + machine evidence passed + identity established

FAIL     machine verification failed              (failureKind: deterministic_verification)
         or exactly one `VERDICT: FAIL`

BLOCKED  reviewer thread could not be created, was not independent, or was
         not read-only; turn did not complete or reported an error; lifecycle
         missing; no verdict marker, both markers, or a repeated marker;
         workspace identity not established; notification history lost;
         attempt budget exhausted; executor thread could not be resumed
```

Machine-verification failure is evaluated before the reviewer's verdict, so
failing tests always reach the executor instead of stalling as BLOCKED.

## Deliberate non-responsibilities

- reviewer prompt design beyond the contract statement
- reviewer tool implementation
- scheduler, daemon, multi-task queue
- taskboard persistence model
- dashi source modification
