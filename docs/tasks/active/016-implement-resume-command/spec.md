# 016 — Implement resume command

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Resume the latest (or specified) run by reloading state and restarting pending work (Level 1).

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/cli/resume.ts | modify | Load prior run state and invoke executor with resume semantics. |
| src/core/state-store.ts | modify | Add helper to locate latest run and load by id. |
| src/core/executor.ts | modify | Support resume mode: running->pending; reuse run_id dirs. |
| src/core/logger.ts | modify | Add resume events: run.resume, task.reset. |

## Blast Radius
- Scope: Operational reliability after crashes or restarts.
- Risk level: Medium — incorrect reset logic can cause unintended reruns or skips.
- Rollback: Disable resume; require fresh run id each time.

## Implementation Checklist
- [ ] Implement `resume --run-id <id>` and default to latest.
- [ ] Load state and reset any running tasks to pending (MVP).
- [ ] Re-run executor using existing directories (logs/state/workspaces).
- [ ] Log resume actions for traceability.

## Verification
- `Manual: create a state file with a task in status=running and confirm resume resets it to pending.`
- `npm test`

## Dependencies
### Blocks
- None

### Blocked by
- 009
- 015
