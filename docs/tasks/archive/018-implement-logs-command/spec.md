# 018 — Implement logs command

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Provide basic log viewing and grep-style searching across JSONL log files.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/cli/logs.ts | modify | Implement logs subcommands: query, search, doctor (MVP: raw). |
| src/core/log-query.ts | add | File scanning helpers (tail, filter by task/type). |
| src/core/paths.ts | modify | Add helpers for per-run log directory discovery. |
| src/core/log-query.test.ts | add | Unit tests for search and filter behavior. |

## Blast Radius
- Scope: Debugging workflows; read-only with respect to execution.
- Risk level: Low — file reading only.
- Rollback: Fallback to printing file paths and instructing users to use grep/jq.

## Implementation Checklist
- [x] Implement `logs --follow` tailing orchestrator.jsonl (best-effort).
- [x] Implement `logs query --task <id>`: print matching lines from task events.
- [x] Implement `logs search <pattern>`: grep across run log tree.
- [x] Ensure commands work cross-platform where possible (Node fs).

## Verification
- `npm test`
- `Manual: create sample jsonl files and confirm `logs search` finds matches.`

## Dependencies
### Blocks
- 027

### Blocked by
- 008
- 009
