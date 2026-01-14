# 032 — Manifest compliance enforcement + access requests

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Detect when a task touches files/resources not declared in its manifest locks/files and emit structured `access.requested` events (with optional blocking policy).

## Model & Effort
- Effort: **L**
- Tier: **pro**

## Files Changing
...
- [ ] Implement a post-run manifest compliance check using git diff vs integration base.
- [ ] Map changed files to project resources via config path globs.
- [ ] Compare actual touched resources/files to manifest `locks` and declared `files.writes`.
- [ ] Emit `access.requested` events when mismatch is detected (include file, inferred resource, and reason).
- [ ] Add config policy: `manifest_enforcement: off|warn|block` (default warn).
- [ ] If policy=block: mark task `needs_rescope` and do not merge; preserve branch for debugging.
- [ ] Write a per-task compliance report file (JSON) under logs.

## Verification
- Manual: create a task manifest that omits a file the worker changes; confirm enforcement emits access.requested and blocks if configured.
- `npm test`

## Dependencies
### Blocks
- 033
- 034

### Blocked by
- 006
- 011
- 015
- 008
- 031
