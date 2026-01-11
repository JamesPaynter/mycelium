# 027 — Index logs with SQLite

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Add optional SQLite indexing for structured log queries beyond grep (future enhancement).

## Model & Effort
- Effort: **L**
- Tier: **pro**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/log-index.ts | add | SQLite schema and ingestion for JSONL events. |
| src/cli/logs.ts | modify | Add query modes backed by SQLite (optional flag). |
| package.json | modify | Add sqlite dependency and scripts. |
| src/core/log-index.test.ts | add | Unit tests for ingestion and query correctness. |

## Blast Radius
- Scope: Improved observability; adds dependency and storage considerations.
- Risk level: Medium — data migrations and performance; keep optional and backward-compatible.
- Rollback: Disable indexing; continue using file-based log queries.

## Implementation Checklist
- [ ] Define SQLite schema for events (ts, type, task_id, json payload).
- [ ] Implement ingestion from JSONL with idempotency per run.
- [ ] Add basic queries: by task, by type glob, by substring match.
- [ ] Ensure logs command gracefully falls back when DB missing.

## Verification
- `npm test`
- `Manual: ingest a sample run and confirm queries return expected events.`

## Dependencies
### Blocks
- None

### Blocked by
- 018
