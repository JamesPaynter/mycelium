# 038 — Cost + token tracking with budgets

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Track tokens/cost per task and per run from Codex streamed events and enforce configurable budgets (hard stop or warn).

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
...
- [ ] Parse token usage from Codex `turn.completed` (or equivalent) events and accumulate per task/attempt.
- [ ] Persist `tokens_used` and `estimated_cost` into run state.
- [ ] Add config: `budgets.max_tokens_per_task`, `budgets.max_cost_per_run`, `budgets.mode: warn|block`.
- [ ] Expose in `status`: total tokens, estimated cost, top tasks by spend.
- [ ] Emit events: `budget.warn`, `budget.block`.

## Verification
- Manual: run a task with a tiny token budget and confirm it stops or warns as configured.
- `npm test`

## Dependencies
### Blocks
- 041

### Blocked by
- 008
- 009
- 014
