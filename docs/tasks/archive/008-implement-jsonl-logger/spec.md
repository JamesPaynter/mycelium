# 008 — Implement JSONL logger

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Create a structured logger that writes orchestrator and per-task JSONL event streams.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/logger.ts | add | JSONL logger with append-only writes and flush guarantees. |
| src/core/logger.test.ts | add | Unit tests for event encoding and file output. |
| src/core/paths.ts | modify | Add log directory helpers. |

## Blast Radius
- Scope: Observability of runs and debugging workflows.
- Risk level: Medium — logging failures can mask issues; must not crash runs unnecessarily.
- Rollback: Fallback to console-only logging; keep file logging best-effort.

## Implementation Checklist
- [x] Define event shape minimally: ts, type, run_id, task_id (optional), payload.
- [x] Implement log rotation strategy as out-of-scope; keep per-run directory.
- [x] Ensure directories are created and writes are atomic/append-only.
- [x] Add tests writing to a temp directory.

## Verification
- `npm test`

## Dependencies
### Blocks
- 009
- 012
- 018

### Blocked by
- 001
