# 036 — Strict TDD mode (tests-first enforcement)

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Implement an optional strict TDD workflow: stage 1 writes failing tests only; stage 2 implements until doctor passes.

## Model & Effort
- Effort: **L**
- Tier: **pro**

## Files Changing
...
- [x] Extend manifest schema with `tdd_mode: off|strict` and `test_paths` patterns (or derive from project config).
- [x] Planner prompt: when `tdd_mode=strict`, require explicit test-first steps and `affected_tests` list.
- [x] Worker strict TDD Stage A: run a Codex turn that changes tests only (no prod code).
- [x] Worker Stage A enforcement: diff must only touch files under `test_paths`.
- [x] Worker Stage A verification: run `verify.fast` and assert it FAILS (expected failing tests).
- [x] Worker strict TDD Stage B: run a Codex turn to implement/refactor until `verify.doctor` passes.
- [x] Add clear failure messages if Stage A unexpectedly passes or touches prod code.
- [x] Add logs/events: `tdd.stage.start`, `tdd.stage.pass`, `tdd.stage.fail`.

## Verification
- Manual: create a strict TDD task in a toy repo and confirm it produces a failing test commit before implementation passes.
- `npm test`

## Dependencies
### Blocks
- 037

### Blocked by
- 033
- 035
- 006
- 014
- 023
