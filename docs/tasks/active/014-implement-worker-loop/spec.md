# 014 — Implement worker loop

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Implement the worker process that runs Codex, executes retries, and commits on doctor pass.

## Model & Effort
- Effort: **L**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| worker/index.ts | add | Worker entrypoint that loads spec/manifest, runs Codex, and doctor loop. |
| worker/codex.ts | add | Codex SDK wrapper for runStreamed and event passthrough. |
| worker/loop.ts | add | Retry loop and doctor execution helpers. |
| worker/logging.ts | add | Structured JSONL emission to stdout. |
| package.json | modify | Add build targets for worker and runtime scripts. |

## Blast Radius
- Scope: Correctness and stability of autonomous execution per task.
- Risk level: High — faulty retries/doctor/commits lead to incomplete or incorrect changes.
- Rollback: Disable retries (max_retries=1) and keep changes unmerged until reviewed.

## Implementation Checklist
- [ ] Implement environment variable contract (TASK_ID, DOCTOR_CMD, MAX_RETRIES, etc.).
- [ ] Load spec.md and manifest.json from mounted task directory (configurable path).
- [ ] Run Codex streamed execution and emit all events with timestamps to stdout.
- [ ] Run doctor command; on pass, git add/commit; on fail, write doctor log file and retry with error context.
- [ ] Exit 0 on success; exit 1 on max retries exceeded.

## Verification
- `npm run build`
- `node dist/worker/index.js --help || true  # optional; ensure worker builds`
- `Manual: run worker in a local repo clone with DOCTOR_CMD='true' and confirm it exits 0 after one attempt.`

## Dependencies
### Blocks
- 015

### Blocked by
- 001
- 010
- 011
