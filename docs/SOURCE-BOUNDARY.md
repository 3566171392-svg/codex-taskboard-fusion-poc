# Source Boundary

## Primary source: dashi-taskboard

https://github.com/chuspeeism/dashi-taskboard

Important reference files:

- `AGENTS.md`
- `skills/manage-taskboard/SKILL.md`
- `skills/manage-taskboard/references/cli.md`
- `shared/taskboard-automation.mjs`
- `shared/task-records.mjs`
- `server/app.mjs`
- `web/src/api.ts`
- `scripts/codex-injector.mjs`
- `scripts/codex-injector-runtime.mjs`
- `cloud/migrations/0007_thread_identity.sql`

Use these for Task status, versioned mutation, comments, native thread binding, and workspace identity.

## Native execution/review source: OpenAI Codex

https://github.com/openai/codex

Relevant areas:

- `codex-rs/app-server/`
- `codex-rs/core/src/tasks/review.rs`
- review-related tests under `codex-rs/core/tests/`
- `codex-rs/skills/src/assets/samples/review-agent/`

The native App Server protocol is authoritative for `review/start`, detached review threads, and review lifecycle events.

## Runtime/capability reference: codex-chatgpt-web

https://github.com/miuuyy/codex-chatgpt-web

Relevant files:

- `docs/architecture.md`
- `docs/security-model.md`
- `src/server.ts`
- `src/bridge.ts`
- `src/codex-integration.ts`
- `src/codex-integration-route.ts`
- `src/adapters/chatgpt-web/browser-worker.ts`
- `src/adapters/chatgpt-web/mcp-server.ts`
- `src/adapters/chatgpt-web/turn-broker.ts`
- `scripts/smoke-codex-subagents.ts`
- `tests/bridge-collaboration.test.ts`

Use these as design references for turn-scoped capability, broker leases, cross-turn isolation, and subagent transport. Do not import this project as a runtime dependency.

## Excluded as runtime base

- https://github.com/openai/symphony
- https://github.com/Ericwong5021/better-codex
- https://github.com/indiekitai/codex-orchestrator
- https://github.com/ajjucoder/codex-team-orchestrator
- https://github.com/52216108/agent-taskboard

These remain references only; none is required to run this POC.
