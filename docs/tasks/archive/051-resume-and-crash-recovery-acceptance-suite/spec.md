# 051 — Resume and crash recovery acceptance suite (reattach + thread resume)

## Status
- [x] Ready
- [x] In progress
- [ ] In review
- [x] Done

## Summary
Prove that “resume” is reliable in practice by adding an acceptance suite covering:
- orchestrator crash mid-run
- container continues running
- orchestrator resume reattaches to the container and continues
- worker resumes the same Codex thread (via persisted worker state)

## Scope
- Add a deterministic acceptance test plan (and ideally an automated harness) for:
  1) Start a run with a task that runs long enough to interrupt.
  2) Kill the orchestrator process (SIGKILL or SIGINT).
  3) Restart with `mycelium resume`.
  4) Confirm:
     - `container.reattach` is logged
     - the run completes
     - worker emits `codex.thread.resumed` (MOCK mode can still emit this event)
- If fully automated is too brittle, add:
  - `docs/ops/resume-drill.md` with exact steps + expected log signatures.

## Out of scope
- Perfect “checkpointed replay” of in-flight tool calls.
- Multi-host resumability.

## Acceptance criteria
- There is a repeatable procedure (automated or documented) that demonstrates:
  - reattach to running container
  - thread resume behavior is observed at least once
- Evidence is captured as:
  - log excerpts (JSONL) and
  - a short run summary output.

## Likely files / areas to change
- docs/ops/resume-drill.md (new)
- (optional) src/__tests__/resume-drill.test.ts (new, if automating)
- src/core/executor.ts (only if harness requires small injection points)
- worker/state.ts / worker/loop.ts (only if test requires deterministic delays)

## Implementation notes
- If automation is attempted:
  - spawn the CLI in a child process and kill it after detecting `task.started` in logs
  - resume and assert `container.reattach`
- Prefer MOCK mode to avoid network dependencies.

## Verification
- Run the drill locally and attach a captured log file to the PR.
- Ensure the drill works twice in a row (idempotent, no manual cleanup required beyond `mycelium clean`).
