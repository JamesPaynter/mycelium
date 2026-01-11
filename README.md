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
- `resources`

### 4) Ensure `.tasks/` is ignored in your target repo

Add this to your **target repo** `.gitignore`:

```
.tasks/
```

### 5) Set credentials

Codex SDK uses `CODEX_API_KEY`.

```bash
export CODEX_API_KEY=... 
```

### 6) Plan (creates `.tasks/`)

```bash
task-orchestrator plan \
  --project my-project \
  --input docs/planning/002-implementation/implementation-plan.md
```

### 7) Run

```bash
task-orchestrator run --project my-project
```

## Repo layout

- `src/` — orchestrator CLI + core engine
- `worker/` — Codex worker that runs inside Docker
- `templates/worker.Dockerfile` — worker image definition
- `projects/example.yaml` — example per-project config

## Notes / assumptions

- This MVP assumes your target repo is a **git repo** and `main_branch` exists (it will create it if missing).
- Workers use **full clones** into `~/.task-orchestrator/workspaces/...` for isolation.
- Scheduling is based on **declared** `locks.reads/writes`. Enforcement is at the scheduler level (not file-system enforcement).

## Known gaps vs your full spec (by design for MVP)

- **True reattachment** to already-running containers on resume (MVP marks `running` as `pending` and reruns).
- **Test validator** and **doctor validator** are not wired yet.
- **Branch push restrictions** are not implemented (this design merges locally).
- No Web UI.

If you want, I can extend this MVP into a “v1” that fills the major gaps (validators, stronger resume semantics, optional remote push, and explicit project bootstrap lifecycles).
