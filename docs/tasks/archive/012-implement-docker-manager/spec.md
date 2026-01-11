# 012 — Implement Docker manager

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

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
- [x] Choose Docker client library (dockerode) and implement container create/start/wait.
- [x] Implement exec helper to run bootstrap commands and worker entrypoint.
- [x] Implement log streaming and best-effort JSON parsing per line.
- [x] Capture container exit codes and surface in state/logs.
- [x] Implement cleanup on success (config flag).

## Verification
- [x] `npm test`
- [x] `npm run build`
- [ ] `docker version  # manual precheck on dev machine (docker not available here)`

## Dependencies
### Blocks
- 013
- 015
- 019

### Blocked by
- 008
- 010
