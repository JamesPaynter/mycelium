# 050 — Docker-mode end-to-end smoke test

## Status
- [x] Ready
- [x] In progress
- [ ] In review
- [x] Done

## Summary
Add a deterministic end-to-end smoke test that exercises the *real Docker execution path* (container create → bind mounts → worker run → logs stream → merge)
without requiring network LLM access (use the existing MOCK mode).

## Scope
- Add a test (or test harness) that:
  - builds or references the worker image
  - runs a small fixture project with `execution.use_docker: true`
  - uses MOCK mode so the worker makes deterministic edits
  - asserts:
    - container starts
    - JSONL events are written
    - task results are merged into main branch
    - run ends in `complete` state
- Gate this test behind an env flag (e.g., `RUN_DOCKER_TESTS=1`) so CI environments without Docker do not fail.
- Add a `scripts/docker-smoke.sh` that mirrors the test and is runnable by humans.

## Out of scope
- Performance benchmarking.
- Testing Codex/OpenAI network calls (keep it deterministic via MOCK).

## Acceptance criteria
- With Docker installed locally:
  - `RUN_DOCKER_TESTS=1 npm test` runs the Docker smoke test and passes.
- Without Docker:
  - default test suite passes and Docker test is skipped with a clear message.
- The smoke test asserts at least one merged commit in the fixture repo.

## Likely files / areas to change
- src/__tests__/docker-e2e.test.ts (new)
- scripts/docker-smoke.sh (new)
- package.json (optional: test script / docs)
- templates/Dockerfile (only if test reveals build issues)

## Implementation notes
- The worker already supports MOCK mode via env/config; prefer reusing that rather than inventing new test-only code paths.
- Use a minimal fixture repo with 1–2 tasks to keep runtime short.
- Assert logs contain expected high-signal events (e.g., `container.created`, `task.completed`, `run.complete`).

## Verification
- Run locally with Docker: `RUN_DOCKER_TESTS=1 npm test`.
- Run locally without Docker (or with env flag off): `npm test`.
