# 028 — Pilot run + acceptance checklist

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Run the full system end-to-end on a real small repo (or the orchestrator repo itself) and capture acceptance criteria, baseline timings, and failure modes.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
...
- [ ] Pick a target repo (recommended: the task-orchestrator repo itself or a tiny toy repo).
- [ ] Create a real project config under `~/.task-orchestrator/projects/<name>.yaml` with resources + doctor + bootstrap.
- [ ] Run an end-to-end flow: `plan` → inspect tasks → `run` → ensure tasks merge into integration branch.
- [ ] Record baseline metrics in `docs/ops/pilot-run.md`: tasks/hour, avg retries, avg doctor runtime, failure classes.
- [ ] Document 'known-good' Docker prerequisites and troubleshooting steps (permissions, Docker Desktop quirks).
- [ ] Add a small acceptance checklist to README: what 'working' means for MVP.

## Verification
- Manual: complete one end-to-end run with ≥3 tasks and at least one retry.
- Manual: confirm logs/state directories contain expected artifacts for the run.

## Dependencies
### Blocks
- 029
- 041
- 042

### Blocked by
- 015
- 023
- 027
