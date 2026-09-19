# v0.3 probe scripts (historical, superseded)

These scripts belong to the v0.3 design, which made `turn/start.outputSchema`
the review verdict channel. v0.4 replaced that with Codex's native
`review/start` on a separate read-only thread, so nothing here is part of the
current Gate.

They are kept because they produced the measurements that motivated the change:

| Script | What it established in v0.3 |
| --- | --- |
| `probe-output-schema.mjs` | the server accepts `outputSchema` and forwards it as `text.format` |
| `probe-schema-enforcement.mjs` | the local provider proxy route returns prose even for unguessable required field names |
| `probe-schema-matrix.mjs` | the same failure across three models — a provider-level, not model-level, gap |
| `live-structured-review.mjs` | structured-review smoke through the local provider proxy route |
| `live-review-loop.mjs` | the earlier real FAIL -> repair -> PASS attempt |
| `make-fixture.mjs` | the workspace fixture used by that loop |

They reference the v0.3 gate API (`src/core/review-contract.mjs`'s JSON schema
validator) and are therefore **not runnable** against v0.4. That is expected,
not a regression.

The v0.4 replacement is `scripts/live-native-review-smoke.mjs` plus
`scripts/live-gate-demo.mjs`.
