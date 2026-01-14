# Pilot run doc polish

We are exercising the orchestrator on its own repo clone. Break the work into **three** small, independent tasks that match the bullets below.

## Task buckets (one task per bullet)
1) Add a pilot-run log page under `docs/ops/` describing how to capture run notes and metrics.
2) Add a troubleshooting snippet about Docker/permissions or worker start hiccups (can be README or docs/ops).
3) Add a lightweight acceptance checklist in README for validating the MVP works end-to-end.

## Constraints
- Docs-only changes; avoid code or dependency changes.
- Keep tasks independent (no cross-task dependencies beyond ordering).
- Keep each task under 20 minutes; prefer clear locking on docs vs code paths.
- Doctor command is `npm test -- --runInBand`; tasks should keep tests green.
