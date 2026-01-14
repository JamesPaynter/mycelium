# 037 — Autopilot supervisor command (LLM-driven operator)

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Add an optional agentic 'supervisor' mode that interviews the human, writes planning artifacts, runs `plan`, then runs `run`—all via LLM-driven tool calls.

## Model & Effort
- Effort: **L**
- Tier: **pro**

## Files Changing
...
- [ ] Add new CLI command: `autopilot --project <name>`.
- [ ] Autopilot should interview the user for goals/constraints (interactive prompts).
- [ ] Autopilot should generate/append planning artifacts under `docs/planning/...` (discovery/architecture/implementation).
- [ ] Autopilot should call the existing planner to produce tickets (`.tasks/`).
- [ ] Autopilot should kick off `run` and stream periodic status updates.
- [ ] Keep the deterministic orchestrator as the engine; autopilot is a thin LLM-driven layer on top.
- [ ] Persist the autopilot conversation transcript to `docs/planning/sessions/<timestamp>-autopilot.md`.

## Verification
- Manual: run autopilot against a toy repo and confirm it produces implementation-plan.md + tasks + starts execution.
- `npm test`

## Dependencies
### Blocks
- 041

### Blocked by
- 021
- 023
- 015
- 028
