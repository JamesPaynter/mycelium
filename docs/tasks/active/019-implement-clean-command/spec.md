# 019 — Implement clean command

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Add cleanup routines for workspaces and optional Docker containers after runs.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/cli/clean.ts | modify | Implement clean CLI options and confirmations. |
| src/core/cleanup.ts | add | Workspace and container cleanup utilities. |
| src/docker/manager.ts | modify | Add list/remove helpers for containers by run id. |
| src/core/cleanup.test.ts | add | Unit tests for path selection and safe deletes. |

## Blast Radius
- Scope: Disk and container hygiene; safety-critical for deletions.
- Risk level: High — deletion bugs can remove unintended data.
- Rollback: Restrict deletion to run-scoped directories only; require --force.

## Implementation Checklist
- [ ] Implement `clean --project <name> [--run-id <id>] [--keep-logs] [--force]`.
- [ ] Only delete inside configured workspacesDir/stateDir/logsDir; refuse to delete outside.
- [ ] Optionally remove containers created by orchestrator when cleanupOnSuccess is true.
- [ ] Log cleanup actions.

## Verification
- `npm test`
- `Manual: run clean in dry-run mode and confirm it prints targets without deleting.`

## Dependencies
### Blocks
- None

### Blocked by
- 009
- 010
- 012
