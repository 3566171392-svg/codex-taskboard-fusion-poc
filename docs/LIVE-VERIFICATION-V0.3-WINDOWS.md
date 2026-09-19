# v0.3 Live Windows Verification (2026-09-19)

Every claim below is backed by a command executed in this session. Raw outputs:
`.live-review-loop-1.json`, `.live-schema-matrix-1.json`,
`docs/LIVE-VERIFICATION-V0.2-WINDOWS.md`.

## Environment

| Item | Value (read from the machine) |
| --- | --- |
| Node | v24.13.0 |
| Codex CLI | codex-cli 0.154.0-alpha.6.2 |
| Codex executable | `codex` |
| Real `CODEX_HOME` | `D:\poc\codex-home` |
| Probe `CODEX_HOME` | `D:\poc\v2-codex-home` (isolated) |
| Model / provider | `<model-a>` / `custom` -> local provider proxy `127.0.0.1:<proxy-port>` |
| dashi `127.0.0.1:47823` | not listening; never started |

## A. Fixed defects

| # | Defect | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Windows file URL used as a filesystem path | **fixed** | `src/core/paths.mjs` uses `fileURLToPath`; rejects a bare `/D:/...` on Windows instead of mangling it. `test/paths.test.mjs` converts the test's own `import.meta.url` to a path that `fs.existsSync` confirms. |
| 2 | `startThread` dropped `historyMode` | **fixed** | Adapter forwards every supported parameter and throws on unknown ones. Test asserts `legacy` and `paginated` both arrive verbatim and that an omitted value keeps the server default. |
| 3 | `waitForReview` event loss | **fixed** | `src/core/notification-log.mjs` adds sequence numbers, cursors, oldest-available tracking and `HistoryLostError`. `waitForTurn` subscribes before draining, so it cannot be evicted by its own slowness. Regression: a 70,000-notification burst still yields `turn/completed`. |
| 4 | `live-app-server-smoke.mjs` path bug + deprecated review call | **fixed** | Rewritten; real run exits 0 and reports `workspace.unchanged: true`. |
| 5 | Gate depended on structured fields `review/start` never emits | **replaced** | Reviewer uses `thread/start` + `turn/start.outputSchema`; `src/core/review-contract.mjs` defines and validates the contract. |

## B. Local tests

| Command | Real exit code | Result |
| --- | --- | --- |
| `npm test` | **0** | 32 tests, 32 pass, 0 fail |
| `npm run lint` | **0** | pass |
| `npm run demo` | **0** | FAIL -> same executor -> new reviewer -> PASS, final `READY_FOR_ACCEPTANCE` |

## C. Real App Server

`scripts/live-app-server-smoke.mjs`, real `codex app-server --stdio`:

```json
{
  "thread": { "executorThreadId": "01a0b8d6-3b7e-7f31-b3ea-d5332041f662",
              "historyMode": "paginated", "sandbox": "readOnly" },
  "executorTurnId": "01a0b8d6-3bcb-7282-ba96-2a1536ff528a",
  "turn": { "status": "completed", "error": null,
            "agentMessages": ["FUSION_EXECUTOR_READY"] },
  "workspace": { "unchanged": true, "files": 11196, "added": [], "removed": [] }
}
```

Exit code 0. The workspace is fingerprinted (path, size, content hash) before
and after the turn; 11,196 files compared, zero differences.

## D. Structured reviewer

Real run, `scripts/live-structured-review.mjs --empty`:

```json
{
  "executorThreadId":  "01a0b8d6-b622-7010-83a9-a6ca485aa94f",
  "reviewerThreadId":  "01a0b8d6-b660-7420-b322-f9d62025b72d",
  "reviewerIsIndependent": true,
  "reviewerSandbox": "readOnly",
  "reviewTurnId": "01a0b8d6-b69b-7280-9cb4-e33ed7b5d135",
  "turnStatus": "completed",
  "structured": {
    "findings": [],
    "overall_correctness": "patch is correct",
    "explanation": "...",
    "confidence": 0.62
  },
  "validation": { "valid": false,
    "errors": ["overall_explanation must be a string",
               "overall_confidence_score must be a number"] },
  "verdict": "BLOCKED"
}
```

| Requirement | Result |
| --- | --- |
| `reviewerThreadId` present | yes |
| `reviewerThreadId !== executorThreadId` | yes |
| sandbox read-only | `readOnly` |
| `outputSchema` accepted by the server | yes (turn completed, no error) |
| response satisfies the schema | **no** — the model emitted `explanation`/`confidence` and wrapped the JSON in a markdown fence |
| JSON stably parseable | parsed, then rejected by the validator |

### Is the schema reaching the model?

Codex forwards the schema to the provider as
`text.format = {name:"codex_output_schema", type:"json_schema", strict:true, schema}`
(`codex-rs/app-server/tests/suite/v2/output_schema.rs`). To test enforcement
rather than good manners, `scripts/probe-schema-enforcement.mjs` requires
unguessable field names (`zeta_marker`, `quux_verdict`).

Three models, three independent turns (`scripts/probe-schema-matrix.mjs`):

| Model | turn completed | honoured schema | returned |
| --- | --- | --- | --- |
| `<model-a>` | yes | **no** | free-form prose |
| `<model-c>` | yes | **no** | free-form prose |
| `<model-b>` | yes | **no** | free-form prose |

The schema is accepted and forwarded but not enforced — a provider-level
capability gap, not a model-specific one.

## E. Real review loop

`scripts/live-review-loop.mjs`, real threads and a real workspace
(`D:\poc\v3-workspace`, built by `scripts/make-fixture.mjs` with a
real inverted cross-product sign):

```
gate.status      : BLOCKED        (attempt 2)
executorThreadId : 01a0b8dd-e0e3-71a1-ac06-d7c0d2a4f7d8   (thread A)
reviewerThreadIds: ["01a0b8dd-e2c0-...", "01a0b8df-0ef5-..."]  (threads B, C)

trace:
  task.in_review
  review.run      attempt 1  reviewer B  readOnly  independent
  gate.verdict    FAIL  deterministic verification failed
  task.rejected / task.reopened
  executor.repaired  attempt 1  executorThreadId = A
  task.repaired
  review.run      attempt 2  reviewer C  readOnly  independent
  gate.verdict    BLOCKED  structured review output did not satisfy the review contract
  gate.blocked
```

Verified independently of any model claim:

| Check | Result |
| --- | --- |
| Executor thread reused after FAIL | yes — A both times, no new executor thread |
| Reviewer threads distinct from executor and from each other | `A != B`, `A != C`, `B != C` |
| Reviewer sandbox | `readOnly` on both attempts |
| Real defect repaired on disk | `crossSign` now `return 1` for `cross > 0`; the fixture had it inverted |
| Real test suite | before `pass 11 / fail 2` -> after `pass 13 / fail 0` |
| Test files untouched by the agent | `test/cross.test.js` hash unchanged; no files added |
| Final Taskboard state | `blocked` — not `done` |

The loop reached PASS on the local gate with a fake app-server (`npm run demo`)
and stopped at BLOCKED on the real provider solely because of the
structured-output gap in §D.

## F. Gate verdicts

| Verdict | Produced by |
| --- | --- |
| PASS | independent reviewer thread + read-only sandbox + turn completed + schema-valid output + `overall_correctness == "patch is correct"` + `findings == []` + machine evidence passed + identity matched. Demonstrated by `npm run demo`; **not reachable on the real provider** |
| FAIL | (a) `testsPassed === false` — observed in the real run, attempt 1; or (b) schema-valid output with `overall_correctness == "patch is incorrect"`; or (c) a "correct" claim carrying non-empty findings |
| BLOCKED | reviewer thread failed/not independent/not read-only; turn aborted; output failed the contract (observed in the real run, attempt 2); identity mismatch; `HISTORY_LOST`; missing evidence |

## G. Remaining blockers

1. **The configured provider does not enforce `turn/start.outputSchema`.**
   `<model-a>` (and two alternatives) ignore the schema entirely, so
   no schema-valid review can be obtained and PASS is unreachable. Everything
   else in the chain is verified working. Resolving this needs either a provider
   that honours the Responses API `text.format` json_schema contract, or an
   explicitly user-authorised decision to obtain the structured verdict another
   way. Adding a prose parser as an automatic PASS path is not an option.
2. **dashi has no review concept** (unchanged from v0.2): a minimal adapter is
   needed to persist a review thread id and verdict. Not attempted; the user's
   instance was not started.

## H. Scope

`D:\poc` was used only as a read-only workspace for the
smoke test; it is unmodified. No dashi source, business project, local provider proxy
configuration, Codex global configuration, MCP server, or plugin was changed.
The real `CODEX_HOME` `config.toml` protected keys are unchanged. All probes ran
against the isolated `CODEX_HOME`.

## Scripts

Current v0.3 scripts:

| Script | Purpose |
| --- | --- |
| `live-app-server-smoke.mjs` | real `initialize` / `thread/start` / `turn/start` / `turn/completed` + workspace fingerprint |
| `live-structured-review.mjs` | real independent read-only reviewer thread with `outputSchema` |
| `live-review-loop.mjs` | real FAIL -> same-executor repair -> new reviewer -> PASS attempt |
| `make-fixture.mjs` | builds the live workspace containing a real defect |
| `probe-output-schema.mjs` | does the server accept `outputSchema` at all? |
| `probe-schema-enforcement.mjs` | does the provider honour it? (unguessable field names) |
| `probe-schema-matrix.mjs` | same question across several models |
| `diagnose-windows-path.mjs` | Windows `pathname` vs `fileURLToPath` |
| `mock-demo.mjs` | offline PASS-path walkthrough of the real gate |

`scripts/v0.2-probes/` holds the probes that produced the v0.2 findings. They
target the removed v0.2 adapter API and are retained for traceability only; see
the README in that directory.
