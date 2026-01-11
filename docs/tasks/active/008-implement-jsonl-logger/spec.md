# 008 — Implement JSONL logger

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

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
- [ ] Define event shape minimally: ts, type, run_id, task_id (optional), payload.
- [ ] Implement log rotation strategy as out-of-scope; keep per-run directory.
- [ ] Ensure directories are created and writes are atomic/append-only.
- [ ] Add tests writing to a temp directory.

## Verification
- `npm test`

## Dependencies
### Blocks
- 009
- 012
- 018

### Blocked by
- 001
