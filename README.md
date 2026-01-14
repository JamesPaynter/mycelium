# Task Orchestrator (MVP Repo)

This repository is a **working starting point** for the “Task Orchestrator” system you specified:

- **Orchestrator** (Node/TypeScript CLI)
- **Workers** (Codex SDK inside Docker)
- **Safe parallel batching** based on declared resource locks
- **Structured JSONL logging** and on-disk run state

It is intentionally an MVP: it runs end-to-end, but it does not yet implement every advanced validator/resume behavior in your full spec.

## What’s implemented

- `plan` — generate `.tasks/...` from an implementation plan via **Codex SDK** structured output
- `run` — load `.tasks`, build conflict-free batches, spawn **Docker** workers in parallel, stream logs, merge successful branches, run integration doctor
- Manifest compliance check after each task with structured `access.requested` events (warn/block via `manifest_enforcement`)
- `status` — show run + task status from persisted state
- `logs` — dump orchestrator or task JSONL logs (simple query)
- `clean` — remove containers/workspaces/logs for a run

## Quick start

### 1) Install

```bash
git clone <this-repo>
cd task-orchestrator
npm install
npm run build
```

### 2) Build the worker image

```bash
npm run docker:build-worker
```

This builds `task-orchestrator-worker:latest` from `templates/Dockerfile`. Override the image tag or Dockerfile path in your project config if you need a custom worker base.

### 3) Create a project config

Copy `projects/example.yaml` to your orchestrator home:

```bash
mkdir -p ~/.task-orchestrator/projects
cp projects/example.yaml ~/.task-orchestrator/projects/my-project.yaml
```

Edit `~/.task-orchestrator/projects/my-project.yaml` and set:

- `repo_path`
- `main_branch`
- `doctor`
- `manifest_enforcement` (off|warn|block, defaults to warn)
- `test_paths` (glob patterns considered tests; defaults cover `__tests__`, `tests/`, and `*.test|spec.*`)
- `resources`

Notes:

- `${VARS}` in the YAML are expanded from your environment.
- Relative paths are resolved from the directory that contains your config file.

### 4) Ensure `.tasks/` is ignored in your target repo

Add this to your **target repo** `.gitignore`:

```
.tasks/
```

### 5) Set credentials

Codex SDK uses `CODEX_API_KEY`. If you switch the planner or validators to OpenAI,
set `OPENAI_API_KEY` instead.

```bash
export CODEX_API_KEY=...
# or
export OPENAI_API_KEY=...
```

### 6) Plan (creates `.tasks/`)

```bash
task-orchestrator plan \
  --project my-project \
  --input docs/planning/002-implementation/implementation-plan.md
```

- Add `--dry-run` to preview task ids without writing files.
- Add `--output <dir>` to change where `.tasks/` are written (defaults to your repo `tasks_dir`).

### 7) Run

```bash
task-orchestrator run --project my-project
```

- Add `--local-worker` to run workers on the host when Docker is unavailable.

## Doctor command expectations

- Use a wrapper script for `doctor` and make it exit non-zero when `ORCH_CANARY=1`.
- The orchestrator reruns doctor with `ORCH_CANARY=1` after a pass; a zero exit on this canary logs `doctor.canary.failed` and blocks merges when the doctor validator mode is `block`.

## MVP acceptance checklist

- `plan` writes task manifests to your tasks directory (default `.tasks/`) from a real implementation plan.
- `run` executes workers (Docker or `--local-worker`), bootstraps per task, and loops until both per-task doctor and integration doctor pass.
- Successful task branches merge into the integration branch with no pending `running` tasks or merge conflicts.
- Integration doctor runs on the integration branch with the same command you expect in CI.
- Logs and state land under `~/.task-orchestrator/logs` and `~/.task-orchestrator/.state`; `status` and `logs` surface the run without digging through files.
- `clean` removes workspaces, containers, and logs once the run is archived.

## Worker image config

- Defaults: `docker.image` → `task-orchestrator-worker:latest`, `docker.dockerfile` → `templates/Dockerfile`, `docker.build_context` → `.`.
- Point `docker.image` at a prebuilt image to skip local builds, or set `docker.dockerfile`/`docker.build_context` to build from your own Dockerfile.
- `templates/codex-config.toml` shows the flat Codex config written to `CODEX_HOME` for workers.

## Development

- Node 20+
- `npm run lint` — ESLint (TypeScript + Node)
- `npm run format:check` — verify Prettier formatting
- `npm run format` — apply Prettier formatting
- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — strict type checking without emit
- `npm test` — run the Node test runner
- `npm start -- --help` — execute the built CLI entrypoint

## Repo layout

- `src/` — orchestrator CLI + core engine
- `worker/` — Codex worker that runs inside Docker
- `templates/Dockerfile` — worker image definition (installs Codex CLI)
- `templates/codex-config.toml` — example Codex config for `CODEX_HOME`
- `projects/example.yaml` — example per-project config

## MVP scope & non-goals

- Dedicated per-task clones live at `~/.task-orchestrator/workspaces/<project>/run-<run-id>/task-<task-id>`; tasks never share a working tree, and manifests are copied into each workspace before execution.
- Resume is **Level 1**: resuming resets `running` tasks to `pending` and reruns them; no container or Codex thread reattachment.
- Validator agents support modes (`off | warn | block`) with a human-review queue; default `warn` keeps advisory behavior, while `block` skips merges when validators fail. `locks.reads/writes` guide scheduling only, and workers have full filesystem access inside their containers.
- See `docs/mvp-scope.md` for details and future upgrades.

## Notes / assumptions

- This MVP assumes your target repo is a **git repo** and `main_branch` exists (it will create it if missing).
- Workers use **full clones** into `~/.task-orchestrator/workspaces/...` for isolation.
- Scheduling is based on **declared** `locks.reads/writes`. Enforcement is at the scheduler level (not file-system enforcement).

## Known gaps vs your full spec (by design for MVP)

- **Resume Level 1 only** — resuming resets `running` tasks to `pending` and reruns them; no container/thread reattachment.
- **Validator agents default to warn** — validators can be set to `block` to skip merges and queue human review; doctor validator still runs on cadence/suspicion.
- **Runtime sandboxing** is not enforced; manifest compliance runs post-task (warn/block) but filesystem access is still wide open during execution.
- **Branch push restrictions** are not implemented (this design merges locally).
- No Web UI.

If you want, I can extend this MVP into a “v1” that fills the major gaps (validators, stronger resume semantics, optional remote push, and explicit project bootstrap lifecycles).
