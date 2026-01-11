# 012 — Implement Docker manager

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Create and manage Docker containers per task with log streaming and exit status capture.

## Model & Effort
- Effort: **L**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/docker/manager.ts | add | Container lifecycle: create/start/exec/wait/remove. |
| src/docker/streams.ts | add | Attach and stream stdout/stderr to logger. |
| src/core/logger.ts | modify | Add helper for raw line logging when JSON parse fails. |
| src/docker/manager.test.ts | add | Lightweight tests (mock docker API or integration tagged). |

## Blast Radius
- Scope: Execution runtime; impacts stability and debuggability of all task runs.
- Risk level: High — Docker edge cases, streaming, and cleanup can destabilize runs.
- Rollback: Provide a 'local exec' fallback mode or run with Docker disabled for dev.

## Implementation Checklist
- [ ] Choose Docker client library (dockerode) and implement container create/start/wait.
- [ ] Implement exec helper to run bootstrap commands and worker entrypoint.
- [ ] Implement log streaming and best-effort JSON parsing per line.
- [ ] Capture container exit codes and surface in state/logs.
- [ ] Implement cleanup on success (config flag).

## Verification
- `npm test`
- `docker version  # manual precheck on dev machine`

## Dependencies
### Blocks
- 013
- 015
- 019

### Blocked by
- 008
- 010
