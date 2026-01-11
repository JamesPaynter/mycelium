# 007 — Implement lock scheduler

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Build parallel batches from resource lock declarations with deterministic ordering.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/scheduler.ts | add | Implement batch building algorithm for reads/writes locks. |
| src/core/task-manifest.ts | modify | Add lock normalization utilities and conflict checks. |
| src/core/scheduler.test.ts | add | Unit tests covering conflict cases and determinism. |

## Blast Radius
- Scope: Parallelization safety and throughput.
- Risk level: High — incorrect scheduling can cause conflicting writes and nondeterminism.
- Rollback: Force serial execution (max_parallel=1) until scheduler is fixed.

## Implementation Checklist
- [x] Implement scheduler per spec: prevent write/write, write/read, read/write conflicts.
- [x] Ensure stable task iteration order (sorted by id).
- [x] Add tests for each conflict matrix row and for multi-batch construction.
- [x] Expose scheduler output as batches for run command.

## Verification
- `npm test`
- `npm run build`

## Dependencies
### Blocks
- 015

### Blocked by
- 006
