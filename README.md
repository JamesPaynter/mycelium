# Mycelium task orchestrator

LLM-driven planner and Docker-isolated Codex workers that plan tasks, run them in parallel, and recover from failures with persisted state.

## What works today
- Autopilot interviews operators, drafts planning artifacts, runs the planner, and kicks off `run` with live status polling.
- `plan`/`run`/`resume` use per-task workspaces, manifest enforcement (`off|warn|block`), auto-rescope for undeclared writes, and merge completed branches into the integration branch.
- Validator agents (test + doctor) support `mode: warn|block`, attach per-task reports, and gate merges when block-mode trips; doctor validator also runs when integration doctor fails or the canary misbehaves.
- Strict TDD worker flow: optional Stage A (tests-only) with `verify.fast`, Stage B implementation + doctor retries, checkpoint commits, and worker state tracking (thread ids, checkpoints) to improve resume.
- Budgets compute token/cost usage from Codex events and emit `budget.warn`/`budget.block` events; block mode halts runs when limits are crossed.
- Logs/state live under `.mycelium` by default (set by the CLI); `logs` can stream raw JSONL or query a SQLite index for timelines/failure digests.

## Docs
- Spec traceability matrix: `docs/spec-traceability.md` maps each spec principle to code, tests, and drills.
- Control plane navigation tools: `docs/control-plane/repo-navigation-tools.md`.

## Run an autopilot pass
1) Install deps: `npm install` (Node 20+).  
2) Build (optional for dev mode): `npm run build`.  
3) In the target repo, initialize config: `npm run dev -- init` → `.mycelium/config.yaml`.  
4) Edit `.mycelium/config.yaml` (set `repo_path`, `doctor`, resources, models, budgets, validator modes, Docker image).  
5) Start autopilot from the target repo:
```bash
npm run dev -- autopilot --project <project-name> --local-worker --max-parallel 1
# Add --plan-input <path> to override the default .mycelium/planning/002-implementation/implementation-plan.md
# Omit --local-worker to use Docker; the image auto-builds unless --no-build-image is set.
```
6) Check progress: `npm run dev -- status --project <project-name>` and `npm run dev -- logs timeline --use-index`.  
7) Resume a paused run (after Ctrl+C or crash): `npm run dev -- resume --project <project-name> --run-id <id> [--local-worker]`.

## Worker Docker image
- Canonical worker build lives at `templates/Dockerfile` (shipped in the npm package) and is the only Dockerfile we support for worker runs.
- Build/publish locally with `npm run docker:build-worker` or `docker build -f templates/Dockerfile -t mycelium-worker:latest .`.
- `npm run dev -- init` writes `.mycelium/config.yaml` pointing at this Dockerfile; keep custom images in sync with it if you copy elsewhere.

## Packaging smoke test
- `npm run pack:smoke` builds, runs `npm pack`, installs the tarball into a temp project, asserts required templates/binaries exist, and runs `mycelium --help` + `mycelium plan --help`.
- Script output includes the temp tarball path if you want to inspect the package contents manually.

## CLI essentials
| Command | Purpose |
| --- | --- |
| `autopilot` | Interview → draft planning artifacts → plan → run (with transcripts in `.mycelium/planning/sessions/`). |
| `plan --input <plan.md>` | Generate `.mycelium/tasks/**` manifests/specs from an implementation plan. |
| `run [--tasks 001,002]` | Execute tasks (Docker by default, `--local-worker` for host mode), enforce manifest policy, merge batches, run integration doctor; Ctrl+C logs `run.stop`, flushes state, and leaves containers running for `resume` (add `--stop-containers-on-exit` to stop them). |
| `resume [--run-id <id>]` | Reload run state, reattach to running containers when present, reset missing ones to pending, and continue with the same Ctrl+C stop semantics as `run`. |
| `status` | Summarize run state (task counts, human-review queue, budgets). |
| `logs [query|search|timeline|failures|doctor|summarize]` | Inspect JSONL logs directly or via SQLite index (`--use-index`). |
| `clean` | Remove workspaces/containers/logs for a run (`--dry-run` and `--force` available). |

## Config quick reference
- Planner/worker models: set `planner` and `worker` blocks (providers: `openai`, `anthropic`, `codex`, `mock`; `reasoning_effort` supported).
- Resources: `resources[].paths` drive scheduler locks; manifests declare `locks.reads/writes` and `files.reads/writes`.
- Control plane: `control_plane.enabled` derives component resources (`component_resource_prefix`), `resources_mode` selects how resources resolve (`prefer-derived`), `fallback_resource` handles unmapped files, `scope_mode` controls compliance enforcement (off/shadow/enforce), `lock_mode` selects declared/shadow/derived scheduling, `control_plane.checks.mode` (off/report/enforce) enables scoped doctor commands via `commands_by_component` with fallback to the global doctor, and `control_plane.surface_locks.enabled` adds `surface:<component>` locks for surface changes.
- Manifest enforcement: `manifest_enforcement: off|warn|block`; violations emit `access.requested` and trigger auto-rescope when possible, unless `control_plane.scope_mode=shadow`.
- Validators: `test_validator` and `doctor_validator` respect `enabled` + `mode` (`warn|block`); doctor validator cadence via `run_every_n_tasks` and also when integration doctor fails or the canary passes unexpectedly.
- Budgets: `budgets.mode warn|block` with `max_tokens_per_task` / `max_cost_per_run`; defaults warn.
- Docker: `docker.image`, `dockerfile`, `build_context`, `user`, `network_mode`, `memory_mb`, `cpu_quota`, `pids_limit`; `--local-worker` skips Docker.
- Layout: `.mycelium/tasks` + `.mycelium/planning` live in the target repo; logs/state default to `<repo>/.mycelium/{logs,state}`; workspaces live under `~/.mycelium/workspaces/<project>/run-<id>/task-<id>`.

## Runtime behavior
- Each task gets its own cloned workspace; manifests/specs are copied in before execution.
- Signals: Ctrl+C/SIGTERM logs `run.stop`, persists state, and leaves task containers running for `resume` (use `--stop-containers-on-exit` on `run`/`resume`/`autopilot` to stop them).
- Resume: run state is persisted after every mutation; `resume` reattaches to labeled containers when they still exist (streams historical logs), otherwise resets those tasks to pending; worker state restores Codex thread ids and checkpoint commits when available.
- Doctors: per-task doctor runs each attempt; integration doctor runs after each batch; canary reruns doctor with `ORCH_CANARY=1` and feeds doctor validator when it passes unexpectedly.
- Strict TDD: when `tdd_mode: "strict"` and `verify.fast` is set, Stage A requires failing tests first; Stage B implements until doctor passes; non-test changes in Stage A fail the attempt.
- Manifest rescope: undeclared writes generate compliance reports and `task.rescope.*` events; successful rescope updates the manifest/locks and retries the task.
- Log summaries: `logs summarize --task <id>` prints validator summaries; add `--llm` to use the configured LLM summaries when enabled.

## Limits and future work
- No filesystem sandbox inside workers; manifest enforcement is post-task (warn/block) rather than live denial.
- Git operations are local; no remote push/branch protection integration yet.
- Resume is best-effort: no in-task checkpoints beyond git commits, and container reattach only works while the container still exists.
- No web UI; CLI + JSONL/SQLite logs are the primary interfaces.
