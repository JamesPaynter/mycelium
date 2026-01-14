# Changelog

## 2026-01-15
- Archived current TODO list snapshot to docs/history/todo-2026-01-15.md; backlog remains complete.
- Added manifest compliance enforcement (git diff vs integration), `access.requested` logging, per-task compliance reports, and optional block-to-rescope handling.

## 2026-01-14
- Added worker checkpoint commits (configurable), checkpoint-to-run-state syncing, and tests covering worker loop and checkpoint merge helpers.
- Added resume handling that reattaches running worker containers via labels, replays logs from history, reconciles exited/missing containers, and emits new container lifecycle events.
- Persisted worker Codex sessions in workspace scope with `.task-orchestrator` state (thread ids, attempts), CODEX_HOME in the workspace volume, thread-aware run-state/status output, and new codex thread start/resume events.

## 2026-01-11
- Added non-blocking test validator agent with JSONL logging, per-task reports, and executor integration.
- Added advisory doctor validator agent with configurable cadence, log sampling, and executor wiring.
- Added optional SQLite-backed log index and CLI flag for indexed log queries with file-based fallback.
- Archived remaining active task specs, captured TODO snapshot, and marked the MVP task backlog complete.
