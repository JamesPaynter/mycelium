# 017 — Implement status command

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Display a concise summary of current/last run: batches, tasks, and timestamps.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/cli/status.ts | modify | Implement status rendering from state file. |
| src/core/state-store.ts | modify | Add read-only helpers for latest run and formatting. |

## Blast Radius
- Scope: Operator visibility; no effect on execution logic.
- Risk level: Low — read-only command.
- Rollback: Keep as minimal JSON dump if formatting is problematic.

## Implementation Checklist
- [ ] Load latest run (or run-id) and print: status, started, updated, batch/task counts.
- [ ] Include task table: id, status, attempts (if tracked), branch name (if tracked).
- [ ] Return non-zero if no runs exist (optional) but print actionable guidance.

## Verification
- `Manual: run status when no state exists and confirm helpful message.`
- `Manual: run status after a run and confirm counts match state JSON.`

## Dependencies
### Blocks
- None

### Blocked by
- 009
