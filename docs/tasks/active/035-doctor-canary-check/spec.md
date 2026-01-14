# 035 — Doctor canary check (prove doctor is executed)

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Add a mechanical canary mechanism to validate the doctor command is actually being run and can fail when expected.

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
...
- [ ] Define an optional canary protocol:
- [ ]   - Orchestrator runs doctor once normally.
- [ ]   - Then runs doctor with `ORCH_CANARY=1` and expects failure.
- [ ] Document the requirement: doctor command should be a wrapper script (recommended) that exits 1 when ORCH_CANARY=1.
- [ ] If canary run unexpectedly passes: emit `doctor.canary.failed` and (if configured) block further merges.
- [ ] Wire into Doctor Validator: include canary result in the validator inputs/report.

## Verification
- Manual: configure a project doctor wrapper that checks ORCH_CANARY and confirm canary fails as expected.
- Manual: configure a project without canary support; confirm system warns clearly (does not silently pass).
- `npm test`

## Dependencies
### Blocks
- 036

### Blocked by
- 034
- 026
