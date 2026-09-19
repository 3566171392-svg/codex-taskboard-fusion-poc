# v0.2 probe scripts (historical, not runnable against v0.3)

These scripts produced the v0.2 evidence recorded in
`docs/LIVE-VERIFICATION-V0.2-WINDOWS.md`. They are kept for traceability of the
findings that shaped v0.3.

They are **not runnable against the v0.3 adapter**. v0.3 removed the
`startReview` / `waitForReview` / `reviewText` surface because Codex deprecated
`review/start` with `delivery: "detached"` and it never emitted the
review-mode lifecycle. Running these files now fails on missing adapter
methods; that is expected, not a regression.

| Script | What it established in v0.2 |
| --- | --- |
| `live-gate-real.mjs` | drove the v0.2 gate against the real app-server; produced the `-32600 paginated threads do not support detached review` result |
| `diagnose-adapter.mjs` | proved `startThread` silently dropped `historyMode` |
| `diagnose-waitforreview.mjs` | deterministically reproduced the `waitForReview` cursor/eviction timeout |
| `extract-probe-summary.mjs` | compacted the large lifecycle-probe JSON |

The findings themselves are unaffected and were fixed in v0.3; see
`docs/STATUS.md` and the v0.3 verification report.
