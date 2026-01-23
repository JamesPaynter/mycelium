# 2026-01-11

## Notes

# 2026-01-14

## Notes
- Created `pilot-local` config pointing at `/tmp/pilot-mycelium` with `--local-worker` fallback and worker doctor fail-once guard.
- Plan/run commands: `npm run dev -- plan --project pilot-local --input planning-docs/pilot-run.md`; `npm run dev -- run --project pilot-local --local-worker --max-parallel 1`.
- Run ID `20260114-140052` (3 tasks) finished in ~7m with one worker doctor retry (Vitest CLI flag mismatch on task 001); avg doctor runtime ~3s.
- Logs: `~/.mycelium/logs/pilot-local/run-20260114-140052/`; workspaces under `~/.mycelium/workspaces/pilot-local/run-20260114-140052/`.
