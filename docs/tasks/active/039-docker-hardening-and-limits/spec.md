# 039 — Docker hardening: non-root, limits, optional no-network

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Harden worker container execution with safer defaults: non-root user, CPU/memory limits, and optional network disabling.

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
...
- [ ] Update worker Dockerfile to run as a non-root user.
- [ ] Add docker run options from config: memory limit, CPU quota, PIDs limit.
- [ ] Add optional `network_mode: none` for offline runs (default: bridge).
- [ ] Ensure logs clearly record the container security settings used per task.
- [ ] Document limitations (some projects require network for dependency install; bootstrap should run before no-network if needed).

## Verification
- Manual: run a worker with `network_mode=none` and confirm it still completes for a repo with vendored deps.
- Manual: confirm container user is non-root (`id` inside container).
- `npm test`

## Dependencies
### Blocks
- 042

### Blocked by
- 012
- 020
