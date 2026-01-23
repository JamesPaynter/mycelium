# Replay Mode for Past Runs

Goal: add a time-ordered “replay” of past runs so we can watch orchestrator + task events at accelerated speeds (or scrub from a start offset), both in CLI and the UI visualizer, using existing JSONL logs.

## Scope
- CLI: `mycelium logs replay` command that streams events from a past run with speed control and optional filters (task ID, event type), starting from t0 or a provided offset.
- UI: visualizer mode that plays back run logs into the existing views (map/garden/task detail), with basic controls (play/pause, speed, jump-to).
- Data: read-only usage of current log formats; no changes to event schemas required.

## Non-goals
- Changing how logs are written.
- Editing run state or re-executing tasks.
- Persisting new artifacts beyond replay-related caches.

## Implementation Plan

### 1) CLI replay pipeline
- Add `mycelium logs replay` subcommand.
- Load orchestrator and task JSONL logs for a run, parse timestamps, order events, and stream them out with a configurable speed multiplier (e.g., 1x, 5x) and optional start offset.
- Support filters: `--task <id>` (one or many), `--type <glob>`, and `--until <ts or +duration>`.
- Default output: plain log lines with relative time annotations; optional `--json` to emit raw events.
- Handle missing timestamps gracefully by falling back to file order with a warning.

### 2) Replay timing + controls
- Implement a scheduler that batches events by delta time, applies the speed factor, and respects pause/resume.
- Add a `--speed` flag (float), `--from <ts or +duration>`, `--to <ts or +duration>`, and `--max-events` for short previews.
- Ensure the loop aborts cleanly on SIGINT/SIGTERM.

### 3) UI replay integration
- Add a replay API endpoint to serve ordered events (with optional filters) from a past run; include basic pagination/chunking to avoid huge payloads.
- Update the UI shell to offer a “Replay” mode for a selected run: controls for play/pause, speed, jump-to, and a minimal timeline scrubber.
- Feed replayed events into the existing views so the map/garden/task panels update as if live, driven by the replay stream.

### 4) Validation and UX polish
- Add helpful errors for missing logs, missing run, or bad flags; point to `mycelium status` for run discovery.
- Ensure replay refuses to mutate state; clearly label output as replay (not live).
- Document usage in README and CLI `--help`.

### 5) Tests
- Unit: event ordering, speed scaling, start/stop offsets, filter combinations.
- Integration: fixture run logs (small) to assert CLI output ordering and timing windows.
- UI: smoke test for the replay endpoint; happy-path render test that walks through a short replay dataset.

## Risks / Mitigations
- Large logs: stream/chunk and apply filters server-side before emitting to UI.
- Sparse/missing timestamps: warn and fall back to file order.
- UI perf: throttle updates (e.g., animation frame) during fast replays.
