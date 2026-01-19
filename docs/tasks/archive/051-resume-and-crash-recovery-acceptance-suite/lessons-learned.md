# Lessons learned — 051 — Resume and crash recovery acceptance suite (reattach + thread resume)

- What worked:
  - Mock Codex runner now mirrors resume semantics in mock mode, so `codex.thread.resumed` fires as soon as an existing thread id is reused.
  - The acceptance harness forces a reliable resume path by killing the orchestrator on `container.start` while the worker keeps running and failing doctor once to guarantee a second Codex turn.
- What didn’t:
  - Docker-gated resume drill stays skipped without `RUN_DOCKER_TESTS`, so we still need a Docker-enabled environment to exercise it regularly.
- Follow-ups:
  - Run the resume drill with `RUN_DOCKER_TESTS=1` in CI or a local Docker environment to capture evidence artifacts.
  - Consider promoting the bootstrap delay + fail-once doctor helper scripts into a shared fixture instead of in-test generation if we reuse them elsewhere.
