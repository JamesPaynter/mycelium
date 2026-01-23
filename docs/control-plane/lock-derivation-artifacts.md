# Lock Derivation Artifacts (Shadow + Derived Modes)

Lock derivation is computed per task to compare declared locks/files with control-plane ownership.
The `control_plane.lock_mode` setting controls how it is used:

- `declared`: no derived artifacts; scheduling uses manifest locks.
- `shadow`: write artifacts; scheduling uses manifest locks.
- `derived`: write artifacts; scheduling uses derived locks (low confidence widens to the fallback resource).

Optional surface locks add `surface:<component>` write locks when a task changes surface
files in that component. Enable with `control_plane.surface_locks.enabled`.

## Scope compliance rollout

Use `control_plane.scope_mode` to control how graph-backed compliance is enforced:

- `off`: skip control-plane scope compliance (reports show `status: skipped`).
- `shadow`: compute compliance reports and `access.requested` events, but do not rescope or block.
- `enforce`: run compliance and enforce `manifest_enforcement` (warn/block) as usual.

`manifest_enforcement` remains the warn/block policy when `scope_mode=enforce`.

## Compliance output

When scope compliance runs with Control Plane enabled, owned files resolve to `component:<id>` before
static resources or the fallback resource. Violations include `component_owners` with component IDs
and owning roots, plus guidance to expand scope or split the task.

## Artifact location

Each task writes one JSON report at:

```
.mycelium/reports/control-plane/lock-derivation/<runId>/<taskId>.json
```

Orchestrator events include the `report_path` in `task.lock_derivation`.

## Report shape

```json
{
  "task_id": "067",
  "task_name": "Derived scope test",
  "derived_write_resources": ["component:acme-web-app"],
  "derived_write_paths": ["apps/web/**"],
  "derived_locks": {
    "reads": [],
    "writes": ["component:acme-web-app", "surface:acme-web-app"]
  },
  "confidence": "high",
  "notes": [],
  "manifest": {
    "locks": { "reads": [], "writes": ["component:acme-web-app"] },
    "files": { "reads": [], "writes": ["apps/web/src/index.ts"] }
  }
}
```

## Confidence heuristics

- `high`: manifest already locks `component:*` resources.
- `medium`: write globs expand to files with complete ownership mapping.
- `low`: expansion yields no files or ownership is missing; report widens to the fallback resource.

## Notes

`notes` is non-empty when the scope is widened (e.g., missing owners or no matching files).
