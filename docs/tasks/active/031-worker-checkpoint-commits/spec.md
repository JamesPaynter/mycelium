# 031 — Worker checkpoint commits (reduce lost work)

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Add a checkpoint strategy so partial progress is not lost across crashes/restarts, and so retries can pick up from committed state.

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
...
- [ ] After each Codex turn (or each N minutes), if there are uncommitted changes, create a WIP checkpoint commit (e.g., `WIP(Task 012): attempt 2 checkpoint`).
- [ ] Record checkpoint commit SHA in run state per attempt.
- [ ] Ensure the final success commit is still created with the normal convention (FEAT/FIX/etc).
- [ ] On retry, worker continues on top of latest commit; do not reset hard unless configured.
- [ ] Add config option: `checkpoint_commits: true|false` (default true for long unattended runs).

## Verification
- Manual: run a task that fails doctor twice; confirm there are checkpoint commits after each attempt.
- Manual: simulate worker crash mid-attempt; restart and confirm no local changes are lost (because last checkpoint exists).
- `npm test`

## Dependencies
### Blocks
- 032

### Blocked by
- 014
- 011
- 030
