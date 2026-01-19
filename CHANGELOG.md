# Changelog

## 2026-01-19
- Added a Docker-mode mock smoke test (gated by `RUN_DOCKER_TESTS`) plus a `scripts/docker-smoke.sh` helper that builds the worker image, runs the fixture project through Docker, and verifies container logs/merge output.
- Rebased documentation on current runtime behavior: rebuilt README, planning docs, and compliance checklist with implemented vs future tables; refreshed MVP scope to reflect autopilot/manifest enforcement/validators/resume reality.

## 2026-01-18
- Archived current TODO list snapshot to docs/history/todo-2026-01-18.md and reset TODO for new work.

## 2026-01-15
- Added mock LLM mode plus a toy fixture repo + integration test that runs `plan`/`run` (max_parallel=2) end-to-end, and wired GitHub Actions CI to run build/tests with Docker available.
- Added operator-grade log tooling: multi-source `logs --follow`, indexed `logs timeline`/`logs failures`, and enhanced `logs summarize` with doctor/Codex context plus optional LLM summaries.
- Added Anthropic LLM provider support for planner/validators with structured outputs, config auth fields, and docs covering provider selection.
- Hardened worker containers with a non-root `worker` user, configurable memory/CPU/PIDs limits, optional no-network mode, and logging that records applied security settings.
- Archived current TODO list snapshot to docs/history/todo-2026-01-15.md; backlog remains complete.
- Added manifest compliance enforcement (git diff vs integration), `access.requested` logging, per-task compliance reports, and optional block-to-rescope handling.
- Added validator block modes with human review queue output, linked validator reports, and a `logs summarize --task` helper.
- Added token usage tracking with estimated cost/budget enforcement, new budget config, status spend summaries, and `budget.warn`/`budget.block` events.

## 2026-01-14
- Added worker checkpoint commits (configurable), checkpoint-to-run-state syncing, and tests covering worker loop and checkpoint merge helpers.
- Added resume handling that reattaches running worker containers via labels, replays logs from history, reconciles exited/missing containers, and emits new container lifecycle events.
- Persisted worker Codex sessions in workspace scope with `.mycelium` state (thread ids, attempts), CODEX_HOME in the workspace volume, thread-aware run-state/status output, and new codex thread start/resume events.
- Added automatic rescope handling for manifest violations, including a new `rescope_required` status, rescope log events, manifest updates for missing locks/files, and task requeueing with updated scheduler locks.
- Added doctor canary enforcement: rerun doctor with `ORCH_CANARY=1`, emit `doctor.canary.*` events, feed results into doctor validator reports, and block merges when the canary unexpectedly passes.
- Added an `autopilot` supervisor CLI that interviews operators, drafts planning artifacts, runs the planner, kicks off runs with status polling, and saves transcripts under `.mycelium/planning/sessions/`.

## 2026-01-11
- Added non-blocking test validator agent with JSONL logging, per-task reports, and executor integration.
- Added advisory doctor validator agent with configurable cadence, log sampling, and executor wiring.
- Added optional SQLite-backed log index and CLI flag for indexed log queries with file-based fallback.
- Archived remaining active task specs, captured TODO snapshot, and marked the MVP task backlog complete.
