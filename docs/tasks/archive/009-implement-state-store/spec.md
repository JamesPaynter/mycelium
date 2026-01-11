# 009 — Implement state store

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Persist run state to disk for crash recovery (Level 1 resumability).

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/state.ts | add | RunState model, transitions, and serialization. |
| src/core/state-store.ts | add | Read/write run state JSON with atomic file replace. |
| src/core/state.test.ts | add | Unit tests for transitions and persistence. |
| src/core/paths.ts | modify | Add state directory helpers. |

## Blast Radius
- Scope: Crash recovery behavior across runs and resumes.
- Risk level: High — incorrect state transitions can lose progress or rerun tasks incorrectly.
- Rollback: Disable resume; run-only mode with ephemeral state.

## Implementation Checklist
- [x] Define RunState per spec (run_id, project, status, batches, tasks map).
- [x] Implement state transitions: start run, start batch, task running/complete/failed, batch complete.
- [x] Persist state after each meaningful transition using atomic write pattern.
- [x] Implement 'Level 1' recovery semantics: on resume, running -> pending.

## Verification
- `npm test`

## Dependencies
### Blocks
- 010
- 015
- 016
- 017
- 018
- 019

### Blocked by
- 006
- 008
