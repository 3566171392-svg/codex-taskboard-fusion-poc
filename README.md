# Codex Taskboard Fusion POC v0.4 — Codex-native Review Gate MVP

This is an intentionally small integration proof-of-concept.

## Core boundary

```text
Dashi Taskboard (control plane)
        |
        v
Codex Executor Thread A            (workspace-write)
        |
        | implementation + machine evidence (real tests, git state, fingerprint)
        v
fresh Reviewer Thread B            (read-only, same workspace)
        |
        | native review/start { delivery: "inline", target: "custom" }
        v
review lifecycle: enteredReviewMode -> exitedReviewMode -> turn/completed
        |
        v
Thin Review Gate
   |        |         |
 FAIL   BLOCKED     PASS
   |        |         |
   v        v         v
Executor  stop/     in_review
A repair  repair    -> human acceptance -> done
```

The reviewer is Codex's own reviewer, running on a separate read-only thread.
This POC does not implement a reviewer agent and does not ask the provider for
structured output.

### The review contract

The reviewer must end its message with exactly one line:

```text
VERDICT: PASS
VERDICT: FAIL
```

The contract is fail-closed, and the count matters:

| Reviewer output | Verdict |
| --- | --- |
| exactly one `VERDICT: PASS` | PASS candidate (machine evidence still has to pass) |
| exactly one `VERDICT: FAIL` | FAIL |
| no marker | BLOCKED |
| `PASS` and `FAIL` together | BLOCKED |
| the same marker twice | BLOCKED |

The Gate never infers a verdict from prose, and never lets position decide an
ambiguous one. A PASS additionally requires the machine evidence to pass and the
workspace identity to be established, so the reviewer's opinion alone can never
release a task.

`review/start` with `delivery: "detached"` is not used: Codex deprecates it,
refuses it on paginated threads, and that path never emits the review lifecycle.
The adapter rejects it outright.

## Commands

```powershell
npm test
npm run lint
npm run demo
npm run live-app-server
npm run live-native-review  # real native review/start lifecycle smoke
```

### Real end-to-end demo

This runs the whole Gate against a real app server, a real model, and a real
workspace containing a genuine failing test:

```powershell
$env:CODEX_HOME           = "D:\poc\v2-codex-home"   # disposable home
$env:FUSION_POC_WORKSPACE = "D:\poc\gate-demo"
$env:FUSION_POC_MODEL = "<model-a>"

npm run make-demo-workspace     # writes only under D:\poc
node scripts/trust-demo-workspace.mjs
npm run live-gate-demo          # FAIL -> executor repair -> new reviewer -> PASS
```

Always point `CODEX_HOME` at a disposable directory: `thread/start` persists
project trust into `$CODEX_HOME/config.toml`, so using the real home would
modify your real configuration.

The live scripts are opt-in, consume real model calls, and do not modify dashi.

## Layout

| Path | Role |
| --- | --- |
| `src/adapters/app-server-stdio.mjs` | App Server JSON-RPC client: threads, turns, native `review/start`, sequence-addressed waiting |
| `src/adapters/taskboard-http.mjs` | dashi-compatible HTTP adapter (versioned move + five-field binding) |
| `src/core/review-contract.mjs` | the `VERDICT:` contract, extraction, and the reviewer instruction |
| `src/core/review-gate.mjs` | the three-layer Gate: completion, verdict, machine evidence |
| `src/core/evidence.mjs` | real workspace evidence: fingerprint, git state, verification exit codes |
| `src/core/notification-log.mjs` | bounded, eviction-aware notification log |
| `src/core/paths.mjs` | platform-safe file URL -> filesystem path |
| `scripts/live-gate-demo.mjs` | real end-to-end demo of the whole Gate |
| `scripts/v0.2-probes/` | historical probes that produced the v0.2 findings |

## Source references

Primary control-plane reference:
- https://github.com/chuspeeism/dashi-taskboard

Codex native App Server / review reference:
- https://developers.openai.com/docs/app-server
- https://github.com/openai/codex/tree/main/codex-rs/app-server
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/review.rs

Additional design references:
- https://github.com/Ericwong5021/better-codex
- https://github.com/indiekitai/codex-orchestrator
- https://github.com/ajjucoder/codex-team-orchestrator
- https://github.com/52216108/agent-taskboard
- https://github.com/miuuyy/codex-chatgpt-web

## Non-goals

No scheduler, daemon, GUI injection, MCP server, product decision engine, tracker polling loop, or direct modification of dashi is included here.
