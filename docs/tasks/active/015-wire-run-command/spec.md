# 015 — Wire run command

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Implement the orchestrator run loop: schedule batches, run tasks in Docker, and merge results.

## Model & Effort
- Effort: **L**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/cli/run.ts | modify | Implement run command orchestration flow. |
| src/core/executor.ts | modify | Main execution loop coordinating scheduler, docker, state, and git merge. |
| src/core/scheduler.ts | modify | Return richer batch metadata (ids, locks) for logging/state. |
| src/core/state.ts | modify | Add batch/task status updates used by executor. |
| src/core/logger.ts | modify | Add orchestrator event helpers. |

## Blast Radius
- Scope: End-to-end system behavior; primary value delivery.
- Risk level: Very High — concurrency and failure handling complexity.
- Rollback: Run in dry-run mode only; or force single-task execution; disable auto-merge.

## Implementation Checklist
- [x] Implement run_id generation and per-run directories (state/logs/workspaces).
- [x] Load tasks, build batches, and enforce max_parallel.
- [x] For each batch: spawn containers for ready tasks; wait for completion; update state.
- [x] On success: fetch from workspaces and merge into main_branch sequentially.
- [x] Run integration doctor after batch merge (config.doctor) and mark batch pass/fail.
- [x] Ensure all critical events are logged as JSONL.

## Verification
- Executed: `npm test`
- Executed: `npm run build`
- Manual: run `node dist/index.js run --project example --dry-run` and confirm batch plan output.
- Manual (integration): with a tiny git repo fixture and a fake worker that exits 0, validate state/log directories are created and merge is attempted.

## Dependencies
### Blocks
- 016
- 025
- 026

### Blocked by
- 007
- 009
- 011
- 012
- 013
- 014
