# v0.2 Live Windows Verification (2026-09-19)

Real run on this machine. Every claim below is backed by a command actually
executed in this session. Raw outputs are preserved in
`.live-review-lifecycle-1.json`, `.live-detached-compact-1.json`,
`.live-gate-real-1.json`.

## Environment

| Item | Value (read from the machine) |
| --- | --- |
| Node | v24.13.0 |
| Codex CLI | codex-cli 0.154.0-alpha.6.2 |
| Codex executable | `codex` |
| Real `CODEX_HOME` | `D:\poc\codex-home` |
| Model / provider | `<model-a>` / `custom` → local provider proxy `127.0.0.1:<proxy-port>` |
| Isolated home used for probes | `D:\poc\v2-codex-home` |
| Workspace | `D:\poc` |
| dashi on `127.0.0.1:47823` | **not listening** (verified; never started) |

## 1. Local POC (`D:\poc`... i.e. the v0.2 package)

| Command | Real exit code | Result |
| --- | --- | --- |
| `npm test` | **1** | 5 tests, 4 pass, 1 fail |
| `npm run lint` | 0 | pass |
| `npm run demo` | 0 | pass |

The failing test is `test/app-server-client.test.mjs:25`. Root cause is a
Windows path bug, not a Codex bug — see §7.

## 2. Real App Server: `initialize` / `thread/start` / `turn/start` / `turn/completed`

Real, via the shipped `scripts/live-app-server-smoke.mjs`:

```
executorThreadId : 01a0b88f-4861-7e70-b2e2-bdfb7dd68b2f
executorTurnId   : 01a0b88f-48a8-7f80-abe7-5a7c64613ead
model            : <model-a>
provider         : custom
cwd              : D:\poc
```

`initialize` returns `platformOs: windows`. `thread/start` returns
`historyMode: "paginated"` for a plain call (this is the default on this build).

`D:\poc` was **not** modified: a full recursive file listing
before and after shows 0 differences, and `project/` (the only git repo in that
tree) still shows exactly its two pre-existing untracked files.

## 3. Native review: the decisive result

### 3.1 `delivery: "detached"` is refused on the default thread

```json
{"code": -32600, "message": "paginated threads do not support detached review"}
```

Confirmed in three independent records (§3.3). Codex's own bundled test asserts
the same error text:
`codex-rs/app-server/tests/suite/v2/review.rs::review_start_rejects_detached_delivery_for_paginated_parent`.

### 3.2 `detached` is deprecated by the vendor

The server emits, on every detached request:

```
review/start with delivery "detached" is deprecated and will be removed in a future release.
Use thread/start followed by review/start with delivery "inline" for a separate review thread,
or thread/fork followed by turn/start with your own review instructions.
```

Same text in `codex-rs/app-server-protocol/src/protocol/v2/review.rs` and
`codex-rs/app-server/src/request_processors/turn_processor.rs`.

### 3.3 What detached actually does (on a legacy thread, where it is allowed)

`review/start {delivery:"detached", target:{type:"uncommittedChanges"}}` on a
legacy thread:

| Observation | Result |
| --- | --- |
| `reviewThreadId` returned | `01a0b898-6546-…` |
| independent from executor thread | **yes** |
| `reviewTurnId` returned | `01a0b898-6589-…` |
| `turn/started` received | yes, on the **review** thread |
| `turn/completed` received | yes, `status: completed`, 1 agentMessage |
| `enteredReviewMode` / `exitedReviewMode` items | **NONE** |

Focused confirmation (`live-detached-lifecycle-compact.mjs`, exit 0):

```json
{
  "reviewThreadIsIndependent": true,
  "turnStarts":     [{"threadId":"01a0b89f-ff5e-…","turnId":"01a0b89f-ffa8-…"}],
  "turnCompletes":  [{"threadId":"01a0b89f-ff5e-…","turnId":"01a0b89f-ffa8-…","status":"completed","agentMessages":1}],
  "reviewModeItems": [],
  "warning": "detached review produced NO enteredReviewMode/exitedReviewMode items"
}
```

Mechanism, from source: `start_inline_review` submits `Op::Review`, whose
`ReviewTask` calls `exit_review_mode` and therefore emits the review-mode items.
`start_detached_review` instead calls `agent_runner.start(AgentInvocation)` —
an agent run with the review prompt, **not** a review task. So detached review
produces a normal agent turn on a forked thread and never enters review mode.

### 3.4 Structured review output is not on the wire

`exitedReviewMode` carries `review: string` only
(`codex-rs/app-server-protocol/src/protocol/v2/item.rs`):

```rust
ExitedReviewMode { id: String, review: String }
```

The projection is:

```rust
CoreTurnItem::ExitedReviewMode(review) => ThreadItem::ExitedReviewMode {
    id: review.id,
    review: review_output_text(review.review_output.as_ref()),
}
```

`review_output_text` runs `render_review_output_text`, which concatenates
`overall_explanation` and a human-readable findings block. The structured fields
(`overall_correctness`, `overall_confidence_score`, the `findings` array with
`code_location`/`priority`/`confidence_score`) are **dropped**.

Measured, real, on the recommended path:

```
reviewTextLength : 2623
reviewTextIsJson : false
reviewTextHead   : "Verified against runtime (Node v24) and the repo's own test suite.
                    Results below. ## Verdict `divide` is essentially correct for
                    finite-number inputs. I found one real behavioral defect ..."
```

Grepping every v2 protocol schema for `overall_correctness`,
`overall_explanation`, `overall_confidence_score`, `reviewOutput`, and
`review_output`: **zero matches**. The gate's `parseNativeReviewOutput` expects
those fields; on this build they arrive only as prose.

### 3.5 The recommended replacement works and does emit the lifecycle

`thread/start` (separate, `read-only`) + `review/start {delivery:"inline"}`:

| Observation | Result |
| --- | --- |
| `reviewThreadId` | equals the thread passed in (inline semantics) |
| independent from the executor thread | **yes** (different thread by construction) |
| `enteredReviewMode` | received (item/started + item/completed) |
| `exitedReviewMode` | received (item/started + item/completed) |
| `turn/completed` | received, `status: completed` |
| exitedReviewMode content | natural-language review, not JSON |

## 4. Thin Review Gate against the real server

`scripts/live-gate-real.mjs` drives the **unmodified** `executeNativeReviewGate`
with the **unmodified** `AppServerStdio`; only the injected dependency was
wrapped to record the protocol replies.

| Phase | Setup | Real outcome |
| --- | --- | --- |
| A | as shipped: `startThread()` with only `sandbox` | gate throws `-32600: paginated threads do not support detached review`; board already moved to `in_review` |
| B | `startThread({historyMode:"legacy"})` | **still paginated** → same `-32600` |
| C | separate thread + inline review | review completed; text is prose, not JSON |

Phase B is itself a finding: `startThread` never forwards `historyMode`, so
`review/start` is sent without it.

Phase C hit a real hang (gate never returned; run aborted after the probe's own
turn wait timed out) — that is the adapter bug in §7.

### Gate verdicts, traced to real code paths

| Verdict | How it is reached | Live status |
| --- | --- | --- |
| PASS | `structured && overall_correctness === "patch is correct" && findings.length === 0` **and** `testsPassed && identityMatches` | **unreachable on this build** — no structured output; real text lands in the `structured:false` fallback whose `overall_correctness` is `null` |
| FAIL | structured `"patch is incorrect"`, or `testsPassed === false` | structured branch unreachable; the `testsPassed:false` branch is reachable and real |
| BLOCKED | `identityMatches === false`, or anything not sufficient for PASS/FAIL (including unstructured review) | reachable; a real review of this build deterministically returns BLOCKED |

So today the observable mapping is `real review → BLOCKED`, and `FAIL` only via
the deterministic-evidence branch. `PASS` cannot be produced by the native
reviewer on this build.

## 5. dashi compatibility

- `127.0.0.1:47823` is **not listening**; the user's instance was never started
  or touched.
- dashi's own app-server client (`server/codex-app-server.mjs`,
  `scripts/codex-injector.mjs`) uses `initialize`, `skills/list`, `thread/start`,
  `thread/resume`, `turn/start`, `thread/compact/start`.
- dashi does **not** call `review/start`, `reviewThreadId`, `detached`,
  `enteredReviewMode`, `exitedReviewMode`, or `ReviewOutputEvent` anywhere
  (recursive grep across `server/`, `shared/`, `scripts/`, `cli/`: zero matches).
- dashi's task/comment binding already carries the native five fields
  (`threadId`, `codexProjectId`, `codexProjectKind`, `codexHostId`,
  `workspacePath`) and a versioned move contract.

**Verdict: a minimal adapter is required.** dashi has no concept of a review
thread or a review verdict, and the gate needs to attach a review turn to an
already-bound executor thread. The smallest necessary interface is:

1. create a separate read-only thread for the review (dashi has `thread/start`);
2. call `review/start` with `delivery:"inline"` on that thread;
3. persist the review thread id + turn id alongside the task;
4. write the review text/verdict as a task comment.

No dashi source change is needed for the first three if the review thread id is
stored via the existing binding/comment mechanism; only a decision about where
the review verdict is persisted is new.

## 6. Working directory integrity

- `D:\poc`: recursive listing before vs after = **0 diffs**.
- `project/` git status unchanged (same two untracked files).
- `project/README.md` and `project/src/math.js` byte-identical to session start.
- Real `D:\poc\codex-home\config.toml`: protected keys all unchanged
  (`model_context_window=1000000`, `model_auto_compact_token_limit=800000`,
  `model_reasoning_effort="max"`, `model_reasoning_summary="auto"`,
  `base_url="http://127.0.0.1:<proxy-port>/v1"`).

## 7. Defects found in v0.2 (reported, not patched)

1. **`npm test` fails on Windows (1 of 5).**
   `new URL("./fake-app-server.cjs", import.meta.url).pathname` yields
   `/D:/%USERPROFILE%/...`; Node resolves it to
   `D:\D:\%USERPROFILE%\...` → `Cannot find module`, exit 1. Proven with
   `scripts/diagnose-windows-path.mjs` (pathname form: exit 1; `fileURLToPath`
   form: exit 0). Same bug and same fix as v0.1.

2. **`startThread` silently drops `historyMode`.**
   Through the adapter the server reports `paginated`; a raw `request("thread/start",
   {historyMode:"legacy"})` on the same connection reports `legacy`
   (`scripts/diagnose-adapter.mjs` → `adapterDroppedIt: true`). Because detached
   review is refused on paginated threads, detached is unreachable through this
   adapter even where the server would allow it.

3. **`waitForReview` loses the terminal notification.**
   It walks `notifications` with an unbounded cursor while `#handleLine` keeps
   only the newest 2,000 entries. `scripts/diagnose-waitforreview.mjs` reproduces
   it deterministically: after 12,000 notifications the promise **times out,
   yet `turn/completed` and `exitedReviewMode` are both still in the buffer**.
   A real review turn emitted **70,383 notifications**, which is why Phase C hung.

4. **`live-app-server-smoke.mjs` cannot complete.**
   It calls `waitForReview` on the same turn, so it fails on the first live run
   rather than merely being inconclusive.

5. **`deriveReviewVerdict` cannot reach PASS on this build** (see §4). The
   "non-structured review → BLOCKED" rule is working as designed; the design's
   PASS branch is simply not backed by the wire format.

## 8. Scripts added for this verification

| Script | Purpose |
| --- | --- |
| `live-native-review-probe.mjs` | detached vs inline, default vs legacy thread |
| `live-review-lifecycle-probe.mjs` | full per-turn notification timeline |
| `live-detached-lifecycle-compact.mjs` | focused: does detached emit review-mode items? |
| `live-gate-real.mjs` | real gate + real app-server, 3 phases |
| `diagnose-adapter.mjs` | `historyMode` drop; notification burst |
| `diagnose-waitforreview.mjs` | deterministic `waitForReview` failure |
| `diagnose-windows-path.mjs` | Windows `pathname` vs `fileURLToPath` |
| `extract-probe-summary.mjs` | compact probe summaries |

No file under `src/`, `test/`, `docs/`, or `package.json` was modified; hashes
are unchanged.
