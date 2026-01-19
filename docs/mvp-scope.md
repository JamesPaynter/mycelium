# MVP scope (2026-01-19)

This file tracks the current, implemented surface area. Use it as the source of truth when aligning specs/docs.

## Current scope
- Autopilot: interviews operators, drafts planning artifacts under `.mycelium/planning`, runs the planner, and kicks off `run` (or stops after planning with `--skip-run`).
- Planning: planner emits manifest/spec pairs to `.mycelium/tasks` using configured resources/locks/files; planner logs to JSONL.
- Execution: per-task clones under `~/.mycelium/workspaces/<project>/run-<id>/task-<task>`, Docker by default with `--local-worker` override; scheduler respects `locks.reads/writes` and `max_parallel`.
- Manifest enforcement: warn/block policies with compliance reports, `access.requested` events, auto-rescope (adds locks/files and requeues) when possible.
- Validators: test + doctor validators with `mode: warn|block`; doctor validator cadence via `run_every_n_tasks` plus triggers on integration doctor failure and canary surprises; block mode queues human review.
- Budgets: token/cost budgets (`warn|block`) derived from Codex usage, emitted as `budget.warn`/`budget.block`.
- Logging: JSONL logs for orchestrator/tasks/validators; optional SQLite index for `logs timeline|failures|search`; transcripts under `.mycelium/planning/sessions/`.
- Resume: persisted run state, best-effort container reattach on `resume`, worker-state sync (thread ids + checkpoint commits); missing containers reset to pending.
- Worker behavior: strict TDD when `tdd_mode: "strict"` and `verify.fast` exists (Stage A tests-only, Stage B implementation), checkpoint commits between doctor attempts, integration doctor + canary per batch.

## How a run works
1. `npm run dev -- autopilot --local-worker --max-parallel 1` (or use Docker by omitting `--local-worker`). Autopilot writes planning artifacts and tasks.
2. `run` executes batches, merging successful branches into the integration branch and running integration doctor + canary per batch.
3. Manifest compliance runs after each task; auto-rescope updates manifests and requeues when possible; remaining violations block merges when policy=`block`.
4. Validators log reports and gate merges in block mode; budgets evaluated after each batch.
5. `resume` can reattach to running containers (via labels) and resets missing ones; worker state restores Codex thread id/checkpoints.
6. Inspect with `logs timeline --use-index`, `logs failures`, `status`, and `logs doctor|summarize`.

## Not in scope (yet)
- Hard filesystem sandboxing inside workers (manifest enforcement is post-task).
- Mid-task checkpoint replay beyond git commits; deterministic resume of partial Codex turns.
- Remote git push/branch protection or multi-host workers.
- Web UI/visualization beyond CLI + JSONL/SQLite.
