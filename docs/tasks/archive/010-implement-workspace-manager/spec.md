# 010 — Implement workspace manager

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Create isolated per-task workspaces via git clone and manage workspace lifecycle.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/workspaces.ts | add | Create/remove workspace directories and clone repositories. |
| src/core/workspaces.test.ts | add | Unit tests with local temp git repo fixture. |
| src/git/git.ts | modify | Branch/remote helpers for workspace setup. |
| src/core/paths.ts | modify | Workspaces directory helpers and task path convention. |
| src/core/executor.ts | modify | Use workspace manager for per-task clones. |

## Blast Radius
- Scope: Isolation guarantees and correctness of parallel execution.
- Risk level: High — workspace bugs can corrupt work or break isolation assumptions.
- Rollback: Run workers against a single serial clone (temporary), or disable parallelism.

## Implementation Checklist
- [x] Implement workspace path convention: workspaces/<project>/run-<run-id>/task-<id>/
- [x] Clone repo_path into workspace; checkout integration branch; create task branch name.
- [x] Ensure idempotency: if workspace exists, either reuse or fail with actionable message.
- [x] Write tests that clone from a local bare repo into temp dirs.

## Verification
- `npm test`
- `npm run build`

## Dependencies
### Blocks
- 011
- 012
- 014
- 019

### Blocked by
- 005
- 009
