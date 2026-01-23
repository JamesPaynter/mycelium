# Mycelium Visualizer Views Task Pack

This zip adds **two new UI views** to the Mycelium Visualizer:

1) **Garden view** — a mushroom-themed “run dashboard” (live mushrooms = running tasks)
2) **Map view** — a mycelium-themed **codebase dependency graph** driven by the Control Plane model

## How to apply

1. Unzip at the **root of your Mycelium repo** so the `.mycelium/` folder lands at:
   - `<repo>/.mycelium/tasks/...`

2. Merge the `TODO.md` content into your repo’s existing TODO (do not overwrite unless that’s your normal workflow).

3. Task numbering:
   - This pack assumes the base UI visualizer tasks are **077–084**.
   - If you already used those IDs for something else, renumber these tasks and update `dependencies` in each `manifest.json`.

## Expected prerequisites

- Base visualizer tasks (077–084) implemented:
  - UI server + summary endpoint
  - cursor-based JSONL tail endpoints
  - frontend MVP list view
  - build packaging

- Control Plane model (Phase A) available for Map view:
  - The Map view reads:
    `<repo_path>/.mycelium/control-plane/models/<base_sha>/model.json`
  - If missing, the UI should show an actionable prompt:
    `mycelium cp build --base-sha <sha>`

## Run order (recommended)

- 085 → 086 → 087 → 088 → 089 → 090
- 091 → 092 → 093 → 094
- 095

## Notes

- The Garden view is designed to remain efficient:
  - it polls `/summary`
  - it tails task events **only for running tasks** (bounded by concurrency), using cursors

- The Map view is intentionally deterministic (no physics sim) so it does not jitter.
