# 013 — Implement bootstrap runner

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Run configured bootstrap commands inside each container before starting the worker.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/bootstrap.ts | add | Execute bootstrap commands (sh -c) via Docker exec. |
| src/docker/manager.ts | modify | Expose exec API that returns stdout/stderr and exit code. |
| src/core/bootstrap.test.ts | add | Unit tests using mocked docker exec results. |
| src/core/config.ts | modify | Add bootstrap field typing and defaults. |

## Blast Radius
- Scope: Environment preparation correctness (dependencies installed) before work begins.
- Risk level: Medium — incorrect bootstrapping causes repeated failures and wasted compute.
- Rollback: Disable bootstrap (empty list) and rely on prebuilt worker images.

## Implementation Checklist
- [ ] Add config support for bootstrap array of commands.
- [ ] Run bootstrap sequentially; stop early on failure and mark task failed.
- [ ] Log each command start/finish events with truncated output.

## Verification
- `npm test`

## Dependencies
### Blocks
- 015

### Blocked by
- 005
- 012
