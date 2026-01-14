# 034 — Make validators blocking + human review queue

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Upgrade test/doctor validators from non-blocking warnings to optional blocking gates, with a clear 'human review required' queue.

## Model & Effort
- Effort: **L**
- Tier: **pro**

## Files Changing
...
- [ ] Add config modes per validator: `off|warn|block` (default warn for MVP; block for hardened runs).
- [ ] Integrate validators into the merge pipeline:
- [ ]   - On task completion: run validators before merge.
- [ ]   - If any validator fails in block mode: mark task `needs_human_review` and skip merge.
- [ ] Persist validator outputs as JSON reports under `logs/validators/...` and link them from run state.
- [ ] Add `status` output section: Human Review Queue (task id, reason, validator, summary).
- [ ] Add `logs summarize --task` helper that summarizes validator failures (optional LLM).

## Verification
- Manual: create a fixture where test validator fails; confirm branch is not merged and task appears in human review queue.
- `npm test`

## Dependencies
### Blocks
- 035

### Blocked by
- 025
- 026
- 011
- 015
