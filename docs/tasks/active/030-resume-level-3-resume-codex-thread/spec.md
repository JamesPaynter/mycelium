# 030 — Resume Level 3: resume Codex thread inside worker

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Persist Codex thread/session identifiers so a restarted worker container can continue the same Codex thread rather than starting from scratch.

## Model & Effort
- Effort: **L**
- Tier: **pro**

## Files Changing
...
- [ ] Define a per-task worker state file in the workspace (e.g., `.task-orchestrator/worker-state.json`) containing `thread_id`, `attempt`, and timestamps.
- [ ] On first attempt, worker starts a new thread and writes `thread_id` to worker-state.
- [ ] On subsequent attempts (and on container restart), worker uses `codex.resumeThread(thread_id)` instead of `startThread()`.
- [ ] Ensure `CODEX_HOME` is persisted in the workspace volume so sessions survive container restarts.
- [ ] Update orchestrator run-state schema to record `thread_id` for observability/debugging.
- [ ] Add events: `codex.thread.started`, `codex.thread.resumed`.

## Verification
- Manual: start a task, stop the container, restart it on the same workspace; confirm worker resumes the same thread id.
- Manual: verify `worker-state.json` persists and is updated per attempt.
- `npm test`

## Dependencies
### Blocks
- 031

### Blocked by
- 014
- 009
- 029
