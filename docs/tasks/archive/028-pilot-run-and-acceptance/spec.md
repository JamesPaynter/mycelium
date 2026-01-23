# 028 — Pilot run + acceptance checklist

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Run the full system end-to-end on a real small repo (or the orchestrator repo itself) and capture acceptance criteria, baseline timings, and failure modes.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
- [x] Pick a target repo (recommended: the mycelium repo itself or a tiny toy repo).
- [x] Create a real project config under `~/.mycelium/projects/<name>.yaml` with resources + doctor + bootstrap.
- [x] Run an end-to-end flow: `plan` → inspect tasks → `run` → ensure tasks merge into integration branch.
- [x] Record baseline metrics in `docs/ops/pilot-run.md`: tasks/hour, avg retries, avg doctor runtime, failure classes.
- [x] Document 'known-good' Docker prerequisites and troubleshooting steps (permissions, Docker Desktop quirks).
- [x] Add a small acceptance checklist to README: what 'working' means for MVP.

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
