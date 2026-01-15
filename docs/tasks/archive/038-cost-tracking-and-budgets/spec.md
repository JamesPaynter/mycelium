# 038 — Cost + token tracking with budgets

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Track tokens/cost per task and per run from Codex streamed events and enforce configurable budgets (hard stop or warn).

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
...
- [x] Parse token usage from Codex `turn.completed` (or equivalent) events and accumulate per task/attempt.
- [x] Persist `tokens_used` and `estimated_cost` into run state.
- [x] Add config: `budgets.max_tokens_per_task`, `budgets.max_cost_per_run`, `budgets.mode: warn|block`.
- [x] Expose in `status`: total tokens, estimated cost, top tasks by spend.
- [x] Emit events: `budget.warn`, `budget.block`.

## Verification
- Manual: run a task with a tiny token budget and confirm it stops or warns as configured (not run in this session).
- `npm test`
- `npm run build`

## Dependencies
### Blocks
- 041

### Blocked by
- 008
- 009
- 014
