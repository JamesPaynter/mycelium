# Mycelium task orchestrator

LLM-driven planner and Docker-isolated Codex workers that plan tasks, run them in parallel, and recover from failures with persisted state.

## What works today
- Autopilot interviews operators, drafts planning artifacts, runs the planner, and kicks off `run` with live status polling.
- `plan`/`run`/`resume` use per-task workspaces, manifest enforcement (`off|warn|block`), auto-rescope for undeclared writes, and merge completed branches into the integration branch.
- Validator agents (test, style, architecture, doctor) support `mode: warn|block`, attach per-task reports, and gate merges when block-mode trips; doctor validator also runs when integration doctor fails or the canary misbehaves.
- Strict TDD worker flow: optional Stage A (tests-only) with `verify.fast`, Stage B implementation + doctor retries, checkpoint commits, and worker state tracking (thread ids, checkpoints) to improve resume.
- Budgets compute token/cost usage from Codex events and emit `budget.warn`/`budget.block` events; block mode halts runs when limits are crossed.
- Logs/state live under `.mycelium` by default (set by the CLI); `logs` can stream raw JSONL or query a SQLite index for timelines/failure digests.

## Docs
- Architecture overview: `docs/architecture/overview.md`.
- Architecture decisions (ADRs): `docs/architecture/adr/`.
- Spec traceability matrix: `docs/spec-traceability.md` maps each spec principle to code, tests, and drills.
- Control graph navigation tools: `docs/control-plane/repo-navigation-tools.md`.
- Error handling runbook: `docs/ops/error-handling.md`.

## Repo layout
- `src/app`: application use-cases and orchestrator wiring.
- `src/core`: shared logic and state.
- `src/cli`: CLI adapter and commands.
- `src/ui`: HTTP/UI adapter and static assets.
- `src/validators`: validator adapters (test/style/doctor/architecture).
- `src/control-plane`: control graph + policy tooling.
- `src/docker`: Docker worker adapter.
- `src/git`: VCS adapter.
- `src/llm`: LLM client adapters.
- `worker/`: task execution loop.

## Architecture boundaries
- `src/core` is framework-agnostic logic; it must not import from `src/cli` or `src/ui`.
- `src/app` hosts use-cases; it can import `src/core` and outbound adapters (`src/validators`, `src/docker`, `src/git`, `src/llm`, `src/control-plane`).
- `src/ui` renders surfaces; it must not import from `src/cli`.
- `src/cli` is the adapter layer; it can import from `src/core` and should stay thin.
- Boundaries are enforced via ESLint restricted import rules (`import/no-restricted-paths`).
- Temporary exception: `src/core/executor.ts` imports the orchestrator while the legacy run engine is strangled.

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

## CI quality gates
- CI runs `npm run typecheck`, `npm run lint`, and `npm run format:check` before build/tests.
- Repo doctor: `./.mycelium/doctor.sh` (used by orchestrator runs).
- Run locally with: `npm run typecheck && npm run lint && npm run format:check`.

## CLI essentials
| Command | Purpose |
| --- | --- |
| `autopilot` | Interview → draft planning artifacts → plan → run (with transcripts in `.mycelium/planning/sessions/`). |
| `plan --input <plan.md>` | Generate `.mycelium/tasks/**` manifests/specs from an implementation plan. |
| `run [--tasks 001,002]` | Execute tasks (Docker by default, `--local-worker` for host mode), enforce manifest policy, merge batches, run integration doctor; Ctrl+C logs `run.stop`, flushes state, and leaves containers running for `resume` (add `--stop-containers-on-exit` to stop them). |
| `resume [--run-id <id>]` | Reload run state, reattach to running containers when present, reset missing ones to pending, and continue with the same Ctrl+C stop semantics as `run`. |
| `status` | Summarize run state (task counts, human-review queue, budgets). |
| `runs list` | List recorded runs (ids, status, timestamps) for a project. |
| `logs [query|search|timeline|failures|doctor|summarize]` | Inspect JSONL logs directly or via SQLite index (`--use-index`). |
| `clean` | Remove workspaces/containers/logs for a run (`--dry-run` and `--force` available). |

## Error handling
- CLI errors print a short block (title + message + optional hint/next) and exit non-zero.
- Add `--debug` to include error codes, causes, and stack traces.
- Example: `mycelium --debug run --project <project-name>`.

## Config quick reference
- Planner/worker models: set `planner` and `worker` blocks (providers: `openai`, `anthropic`, `codex`, `mock`; `reasoning_effort` supported).
- Resources: `resources[].paths` drive scheduler locks; manifests declare `locks.reads/writes` and `files.reads/writes`.
- Control graph: `control_graph.enabled` derives component resources (`component_resource_prefix`), `resources_mode` selects how resources resolve (`prefer-derived`), `fallback_resource` handles unmapped files, `scope_mode` controls compliance enforcement (off/shadow/enforce), `lock_mode` selects declared/shadow/derived scheduling, `control_graph.checks.mode` (off/report/enforce) enables scoped doctor commands via `commands_by_component` with fallback to the global doctor, and `control_graph.surface_locks.enabled` adds `surface:<component>` locks for surface changes. Legacy `control_plane` remains accepted.
- Manifest enforcement: `manifest_enforcement: off|warn|block`; violations emit `access.requested` and trigger auto-rescope when possible, unless `control_graph.scope_mode=shadow`.
- Task failure policy: `task_failure_policy: retry|fail_fast` (default `retry`); retry treats worker non-zero exits as retryable and resets tasks to pending, while `fail_fast` treats them as catastrophic and fails the task/run.
- Worker retries: `max_retries` caps per-task worker attempts (`0` means retry forever); hitting the limit causes the worker to exit non-zero.
- Validators: `test_validator`, `style_validator`, `architecture_validator`, and `doctor_validator` respect `enabled` + `mode` (`warn|block`); architecture validator uses `docs_glob` + `fail_if_docs_missing`, doctor validator cadence via `run_every_n_tasks` and also when integration doctor fails or the canary passes unexpectedly.
- Doctor canary: configure `doctor_canary` (`mode: off|env`, `env_var`, `warn_on_unexpected_pass`) to control the integration doctor re-run and warning behavior.
- Budgets: `budgets.mode warn|block` with `max_tokens_per_task` / `max_cost_per_run`; defaults warn.
- Cleanup: `cleanup.workspaces` / `cleanup.containers` set to `on_success` to remove task workspaces/containers after the integration doctor passes; defaults `never`.
- Docker: `docker.image`, `dockerfile`, `build_context`, `user`, `network_mode`, `memory_mb`, `cpu_quota`, `pids_limit`; `--local-worker` skips Docker.
- Layout: `.mycelium/tasks` + `.mycelium/planning` live in the target repo; logs/state default to `<repo>/.mycelium/{logs,state}`; workspaces live under `~/.mycelium/workspaces/<project>/run-<id>/task-<id>`.

## Runtime behavior
- Each task gets its own cloned workspace; manifests/specs are copied in before execution.
- Signals: Ctrl+C/SIGTERM logs `run.stop`, persists state, and leaves task containers running for `resume` (use `--stop-containers-on-exit` on `run`/`resume`/`autopilot` to stop them).
- Resume: run state is persisted after every mutation; `resume` reattaches to labeled containers when they still exist (streams historical logs), otherwise resets those tasks to pending; worker state restores Codex thread ids and checkpoint commits when available.
- Doctors: per-task doctor runs each attempt; integration doctor runs after each batch; canary reruns doctor with `doctor_canary.env_var=1` (default `ORCH_CANARY`) unless `doctor_canary.mode=off`.
- Worker retries: tasks loop through attempts until doctor passes or `max_retries` is hit (`0` = retry forever); worker crashes/non-zero exits reset tasks to pending when `task_failure_policy=retry`.
- Strict TDD: when `tdd_mode: "strict"` and `verify.fast` is set, Stage A requires failing tests first; Stage B implements until doctor passes; non-test changes in Stage A fail the attempt.
- Attempt summaries: each worker attempt writes `attempt-<N>.summary.json` plus `attempts.summary.md` under the task run logs dir (`<mycelium_home>/logs/<project>/run-<id>/tasks/<taskId>-<slug>`). Summaries include phase, retry reason + evidence paths, changed files, scope divergence vs `manifest.files.writes`, and TDD signals.
- Scope drift: changes outside `manifest.files.writes` are recorded in attempt summaries and compliance reports; `control_graph.scope_mode=shadow` logs without blocking, while `manifest_enforcement=block` or `scope_mode=enforce` can stop and rescope.
- Manifest rescope: undeclared writes generate compliance reports and `task.rescope.*` events; successful rescope updates the manifest/locks and retries the task.
- Log summaries: `logs summarize --task <id>` prints validator summaries; add `--llm` to use the configured LLM summaries when enabled.

Example doctor wrapper (update the env var name if you customize `doctor_canary.env_var`):
```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "${ORCH_CANARY:-}" == "1" ]]; then
  echo "ORCH_CANARY=1: failing as expected"
  exit 1
fi

npm test
```

## Limits and future work
- No filesystem sandbox inside workers; manifest enforcement is post-task (warn/block) rather than live denial.
- Git operations are local; no remote push/branch protection integration yet.
- Resume is best-effort: no in-task checkpoints beyond git commits, and container reattach only works while the container still exists.
- No web UI; CLI + JSONL/SQLite logs are the primary interfaces.
