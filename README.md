# Mycelium

Codex-powered task orchestration for long-running software delivery.

Mycelium turns an implementation plan into explicit tasks, runs them in isolated workers
(Docker by default), validates outcomes, and can resume after interruptions.


## What you get

- Autopilot flow: interview -> planning artifacts -> task generation -> run.
- Task runner: per-task workspaces + task branches, parallel scheduling, checkpoint commits, resume.
- Safety rails: per-task manifests (declared reads/writes + locks) with `off|warn|block` enforcement.
- Validation: repo doctor + optional LLM validators (test/style/architecture/doctor) that can gate merges.
- Observability: JSONL logs, optional SQLite index for fast queries, failure digests, UI visualizer.
- Repo navigation: control graph commands (`mycelium cg ...`) for ownership, deps, blast radius, symbols.


## Quickstart (run on a target repo)

### Requirements

- Node 20+
- Git repo (Mycelium discovers the repo root via `.git`)
- Docker (recommended), or use `--local-worker` to run workers on the host
- API key for your chosen provider:
  - `CODEX_API_KEY` (Codex)
  - `OPENAI_API_KEY` (OpenAI)
  - `ANTHROPIC_API_KEY` (Anthropic)

### Install (from this repo)

```bash
npm install
npm run build
npm link
```

### Initialize in your target repo

```bash
mycelium init
```

This scaffolds:

- `.mycelium/config.yaml` (project config)
- `.mycelium/doctor.sh` (integration doctor stub; update it for your repo)
- `.mycelium/planning/002-implementation/implementation-plan.md` (starter stub)
- `.mycelium/tasks/` (generated task specs/manifests)
- `.mycelium/.gitignore` (keeps Mycelium artifacts out of git)

### Configure

Edit `<repo>/.mycelium/config.yaml`:

- Set `doctor` to a real verification command (usually `./.mycelium/doctor.sh`).
- Configure `planner` + `worker` provider/models.
- Set `bootstrap` for worker setup (example: `npm ci`).

### Run

Option A: autopilot (end-to-end)

```bash
mycelium autopilot --max-parallel 2
```

Option B: plan + run

```bash
mycelium plan --input .mycelium/planning/002-implementation/implementation-plan.md
mycelium run --max-parallel 2
```

Resume after Ctrl+C or a crash:

```bash
mycelium resume --run-id <id>
```

Check status:

```bash
mycelium status --run-id <id>
```


## UI (Visualizer)

Start the localhost-only UI server for a run:

```bash
mycelium ui --run-id <id>
```

`run` and `resume` can also launch the UI via config/flags (`--ui`, `--ui-port`, `--ui-open`).


## Logs

`logs` requires a project name (most other commands default it from the repo folder name).

```bash
mycelium logs --project <project> --run-id <id> --use-index
mycelium logs timeline --project <project> --run-id <id> --use-index
mycelium logs failures --project <project> --run-id <id>
mycelium logs summarize --project <project> --run-id <id> --task 001 --llm
```


## Control graph (repo navigation)

```bash
mycelium cg build
mycelium cg owner src/index.ts
mycelium cg deps <component-id>
mycelium cg symbols find "buildCli"
```

See `docs/control-plane/repo-navigation-tools.md` for the full surface.


## Storage locations

- Repo-scoped config and task artifacts live under `<repo>/.mycelium/`.
- Runtime state/logs/workspaces live under `<MYCELIUM_HOME>/` (default: `<repo_path>/.mycelium`).


## Development (this repo)

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Packaging smoke test:

```bash
npm run pack:smoke
```

Worker image build:

```bash
npm run docker:build-worker
```


## Docs

- Architecture overview: `docs/architecture/overview.md`
- ADRs: `docs/architecture/adr/`
- Ops runbooks: `docs/ops/`
- Spec traceability: `docs/spec-traceability.md`


## Repo layout (high level)

- `src/app/`: use-cases and orchestration wiring
- `src/core/`: shared logic and state (CLI/UI-free)
- `src/cli/`: CLI adapter and command wiring
- `src/ui/`: HTTP/UI adapter + static assets
- `src/validators/`: validator adapters (test/style/doctor/architecture)
- `src/control-plane/`: control graph + policy tooling
- `src/docker/`: Docker worker adapter
- `src/git/`: VCS adapter
- `src/llm/`: LLM client adapters
- `worker/`: task execution loop


## License

Apache-2.0 (see `LICENSE`).
