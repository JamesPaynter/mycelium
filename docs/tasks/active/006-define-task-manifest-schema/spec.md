# 006 — Define task manifest schema

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Define and validate the task manifest JSON format and loader for .tasks/ directories.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/task-manifest.ts | add | Zod/JSON-schema for task manifest and normalization helpers. |
| src/core/task-loader.ts | add | Load tasks from a directory and validate each manifest.json. |
| src/core/paths.ts | add | Centralize paths for state/log/workspace directories. |
| src/cli/run.ts | modify | Load task manifests (stub) for run flow. |

## Blast Radius
- Scope: Task discovery and correctness for scheduling and execution.
- Risk level: Medium — schema drift breaks planner compatibility.
- Rollback: Relax schema validation; log warnings for unknown fields.

## Implementation Checklist
- [ ] Implement manifest schema per spec (id, name, description, estimated_minutes, locks, files, verify).
- [ ] Validate resource lock arrays and ensure no unknown resource names (when resources are known).
- [ ] Implement loader scanning .tasks/*/manifest.json and sorting by id.
- [ ] Surface per-task validation errors without crashing whole run unless configured.

## Verification
- `npm test`
- `node dist/index.js run --project example --dry-run || true  # should enumerate tasks and print count`

## Dependencies
### Blocks
- 007
- 009
- 023

### Blocked by
- 005
