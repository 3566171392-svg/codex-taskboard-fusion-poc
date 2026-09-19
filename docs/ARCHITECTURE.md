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
| B. Verdict extraction | exactly one `VERDICT: PASS` or `VERDICT: FAIL` line; both markers or neither is ambiguous | BLOCKED |
| C. Machine evidence | required verification commands pass, workspace identity matches, no notification history loss | FAIL when a check fails, BLOCKED on identity/history problems |

Machine evidence is evaluated **before** the reviewer's opinion, so failing
tests always reach the executor instead of stalling as BLOCKED. A PASS needs
both the marker and passing machine evidence; prose alone is never a PASS.

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
PASS     independent reviewer thread + read-only sandbox + review turn completed
         + review lifecycle observed + exactly one "VERDICT: PASS" line
         + machine evidence passed

FAIL     machine verification failed              (failureKind: deterministic_verification)
         or exactly one "VERDICT: FAIL" line

BLOCKED  reviewer thread could not be created, was not independent, or was
         not read-only; turn did not complete; no verdict line, or both verdict
         lines (ambiguous); notification history lost; attempts exhausted
```

Machine evidence is evaluated before the reviewer's verdict, so a failing test
always reaches the executor instead of stalling as BLOCKED.

## Deliberate non-responsibilities

- reviewer prompt design beyond the contract statement
- reviewer tool implementation
- scheduler, daemon, multi-task queue
- taskboard persistence model
- dashi source modification
