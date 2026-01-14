# Pilot run (2026-01-14)

## Run summary
- Project: `pilot-local` in `/tmp/pilot-task-orchestrator` (fresh clone of this repo).
- Worker mode: `--local-worker` (Codex runs on host; Docker available but not required for this pass).
- Doctor command: fail-once guard via `WORKER_FAIL_ONCE_FILE`, then `npm test -- --runInBand`.
- Tasks planned from `planning-docs/pilot-run.md` → 3 doc-only tasks (`.tasks/001-003`).
- Run ID: `20260114-140052`; logs live under `~/.task-orchestrator/logs/pilot-local/run-20260114-140052/`.

## Metrics (run 20260114-140052)
- Tasks completed: 3 (doc-only) across 3 batches (`max_parallel=1`).
- Runtime: ~7m00s start-to-finish ≈ 26 tasks/hour.
- Retries: 1 doctor retry (task 001) triggered by a Vitest CLI flag mismatch; tasks 002/003 were single-pass. Average ≈0.33 retries per task.
- Doctor timings: worker doctor ~3.0s per attempt (4 attempts total), integration doctor ~3.4s per batch.

## Failure classes observed
- Vitest CLI rejected `--runInBand` on the first doctor attempt in task 001; Codex adjusted the test runner invocation and passed on retry.
- No Docker/runtime issues in local-worker mode; keep Docker fallback handy if the daemon is unavailable.

## Docker prerequisites & troubleshooting
- Known-good baseline: Docker 20.10+, daemon running, and access to `/var/run/docker.sock`. If iptables is restricted, `dockerd --iptables=false --storage-driver=vfs` avoids NAT setup for dev runs.
- On Docker Desktop: enable virtualization, allocate ≥4GB RAM, and allow file sharing for the repo + `~/.task-orchestrator`.
- Permission errors: verify the current user is in the `docker` group or run `--local-worker` to bypass Docker while diagnosing.
- Network pulls: ensure base images can be fetched before `run` or prebuild the worker image (`npm run docker:build-worker`).

## Re-run commands
- Plan: `npm run dev -- plan --project pilot-local --input /workspace/packages/planning-docs/pilot-run.md`
- Run (local worker): `npm run dev -- run --project pilot-local --local-worker --max-parallel 1`
- Inspect: `npm run dev -- status --project pilot-local` and `npm run dev -- logs query --run-id 20260114-140052`
- Cleanup: `npm run dev -- clean --project pilot-local --run-id 20260114-140052 --force`
