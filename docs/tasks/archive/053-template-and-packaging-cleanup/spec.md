# 053 — Template & packaging cleanup (reduce ambiguity)

## Status
- [x] Ready
- [x] In progress
- [ ] In review
- [x] Done

## Summary
Reduce “paper cuts” and ambiguity by clarifying or consolidating build templates (Dockerfiles, Codex TOMLs) and ensuring the published package includes exactly what runtime needs.

## Scope
- Decide on a single authoritative worker Dockerfile:
  - either keep `templates/Dockerfile` and remove/rename `templates/worker.Dockerfile`, or
  - document why both exist and when to use each.
- Ensure `package.json` `files` list includes all runtime templates needed for:
  - `mycelium autopilot`
  - `mycelium plan`
  - Docker worker runs
- Add a quick “pack/install smoke” script that:
  - runs `npm pack`
  - installs into a temp dir
  - runs `mycelium --help` and `mycelium plan --help`

## Out of scope
- Publishing to npm registry.

## Acceptance criteria
- There is one clear documented way to build/run the worker image.
- `npm pack` smoke script passes and confirms templates exist in the installed package.

## Likely files / areas to change
- templates/Dockerfile
- templates/worker.Dockerfile
- templates/codex/*.toml
- package.json
- scripts/pack-smoke.sh (new)
- README.md

## Implementation notes
- This task is about *developer ergonomics* and preventing “works in repo, breaks when installed”.

## Verification
- Run `scripts/pack-smoke.sh` on a clean machine/CI runner.
