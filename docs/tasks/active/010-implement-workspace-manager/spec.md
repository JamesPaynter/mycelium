# 010 — Implement workspace manager

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Create isolated per-task workspaces via git clone and manage workspace lifecycle.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/workspaces.ts | add | Create/remove workspace directories and clone repositories. |
| src/git/git.ts | add | Small helper to run git commands with cwd and logging. |
| src/core/workspaces.test.ts | add | Unit tests with local temp git repo fixture. |
| src/core/paths.ts | modify | Add workspaces directory helpers. |

## Blast Radius
- Scope: Isolation guarantees and correctness of parallel execution.
- Risk level: High — workspace bugs can corrupt work or break isolation assumptions.
- Rollback: Run workers against a single serial clone (temporary), or disable parallelism.

## Implementation Checklist
- [ ] Implement workspace path convention: workspaces/<project>/run-<run-id>/task-<id>/
- [ ] Clone repo_path into workspace; checkout integration branch; create task branch name.
- [ ] Ensure idempotency: if workspace exists, either reuse or fail with actionable message.
- [ ] Write tests that clone from a local bare repo into temp dirs.

## Verification
- `npm test`

## Dependencies
### Blocks
- 011
- 012
- 014
- 019

### Blocked by
- 005
- 009
