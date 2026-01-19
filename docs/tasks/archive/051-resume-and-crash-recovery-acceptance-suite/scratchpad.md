# Scratchpad — 051 — Resume and crash recovery acceptance suite (reattach + thread resume)

- 2026-01-20
  - Notes:
    - Acceptance flow: run mock fixture in Docker, kill orchestrator after container starts, resume and expect container.reattach + codex.thread.resumed + run completes.
    - Use bootstrap delay + fail-once doctor script to keep container alive and force second Codex turn for resume event.
    - Gate automation behind RUN_DOCKER_TESTS like the existing Docker smoke to avoid breaking environments without Docker.
    - Added mock Codex runner resume detection in mock mode so a resumed thread id logs `codex.thread.resumed` immediately.
    - Automated harness: new Vitest `resume-drill` test spins CLI run, kills orchestrator on `container.start`, runs `resume`, and checks logs/state.
  - Commands:
    - `npm test` (Docker-gated resume test skipped without RUN_DOCKER_TESTS)
    - `npm run build`
  - Decisions:
    - Adjust mock Codex runner to emit codex.thread.resumed when resuming with an existing thread id so MOCK aligns with real resume behavior.
