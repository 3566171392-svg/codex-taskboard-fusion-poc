# v0.4 probes — native review scope and reviewer sandbox

These probes answer two questions the v0.4 architecture depends on. They are
not part of the Gate; they are measurement, and they only write under
`D:\poc\`.

| Script | What it establishes |
| --- | --- |
| `make-uncommitted-fixture.mjs` | builds the disposable git workspace: modified / staged / untracked changes plus clean control files, each carrying a defect that contradicts its own docstring |
| `probe-uncommitted-review.mjs` | runs a real native review on that workspace and measures what the reviewer actually saw. `FUSION_POC_REVIEW_MODE=uncommittedChanges` (default) or `custom` |
| `probe-reviewer-sandbox.mjs` | orders the reviewer to mutate the workspace under `read-only` and under `workspace-write`, and compares the two |

Findings and their limits: `docs/RESEARCH-NATIVE-REVIEW-SCOPE.md`.

## Running

```powershell
cd <repo>
node scripts/v0.4-probes/make-uncommitted-fixture.mjs

$env:FUSION_POC_CODEX_HOME   = "D:\poc\v2-codex-home"   # disposable home
$env:FUSION_POC_WORKSPACE    = "D:\poc\uncommitted-review-probe"
node scripts/trust-demo-workspace.mjs

$env:FUSION_POC_MODEL        = "<your-model>"
$env:FUSION_POC_FIXTURE_ROOT = "D:\poc\uncommitted-review-probe"
$env:FUSION_POC_OUT          = "D:\poc\probe-uncommitted-review.json"

node scripts/v0.4-probes/probe-uncommitted-review.mjs
$env:FUSION_POC_REVIEW_MODE = "custom"      # second condition, same fixture
node scripts/v0.4-probes/probe-uncommitted-review.mjs

node scripts/v0.4-probes/probe-reviewer-sandbox.mjs
```

Each probe prints a JSON report and refuses to run against an untrusted
workspace, because an untrusted project makes the reviewer unable to read the
tree — which would be misread as "the reviewer found nothing".

The probes never print a credential; the model route is whatever the isolated
`CODEX_HOME` is already configured with.
