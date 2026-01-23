# 020 — Add worker image templates

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Add baseline Dockerfile template and Codex config template aligned with corrected spec.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| templates/Dockerfile | add | Base worker image including git, node, python, and codex CLI. |
| templates/codex-config.toml | add | Flat-key Codex config: model, approval_policy, sandbox_mode. |
| src/docker/builder.ts | add | Optional image build helper (MVP: best-effort or stub). |
| README.md | modify | Document how to build the worker image. |

## Blast Radius
- Scope: Runtime environment for workers; affects compatibility across projects.
- Risk level: Medium — missing deps cause doctor/bootstrap failures.
- Rollback: Allow user to provide custom docker image via config; skip internal build.

## Implementation Checklist
- [x] Create templates/Dockerfile as in spec (node:20-bookworm base, install dependencies).
- [x] Create codex-config.toml using corrected flat keys.
- [x] Document how config points to docker.image or dockerfile override.

## Verification
- `docker build -f templates/Dockerfile -t mycelium-worker:dev .`
- `Manual: run `docker run --rm mycelium-worker:dev node -v``

## Dependencies
### Blocks
- None

### Blocked by
- 001
