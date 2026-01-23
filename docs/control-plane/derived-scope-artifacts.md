# Derived Scope Artifacts (Shadow + Derived Modes)

Derived scope is computed per task to compare declared locks/files with control-plane ownership.
The `control_plane.lock_mode` setting controls how it is used:

- `declared`: no derived artifacts; scheduling uses manifest locks.
- `shadow`: write artifacts; scheduling uses manifest locks.
- `derived`: write artifacts; scheduling uses derived locks (low confidence widens to the fallback resource).

## Artifact location

Each task writes one JSON report at:

```
.mycelium/reports/control-plane/derived-scope/<runId>/<taskId>.json
```

Orchestrator events include the `report_path` in `task.derived_scope`.

## Report shape

```json
{
  "task_id": "067",
  "task_name": "Derived scope test",
  "derived_write_resources": ["component:acme-web-app"],
  "derived_write_paths": ["apps/web/**"],
  "derived_locks": { "reads": [], "writes": ["component:acme-web-app"] },
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
