# Blast Radius Artifacts (Phase B)

Blast radius is computed per task from the task diff and the control-plane dependency graph.
The impacted set is conservative: when the graph is uncertain, it widens to all components.

## Artifact location

Each task writes one JSON report at:

```
.mycelium/reports/control-plane/blast/<runId>/<taskId>.json
```

## Report shape

```json
{
  "task_id": "070",
  "task_name": "Blast radius artifacts",
  "base_sha": "abc123",
  "changed_files": ["packages/utils/src/index.ts"],
  "touched_components": ["acme-utils"],
  "impacted_components": ["acme-utils", "acme-web-app"],
  "confidence": "medium",
  "widening_reasons": [],
  "unmapped_paths": []
}
```

## Widening reasons

`widening_reasons` explains why impacted components were widened to all components:

- `unmapped_paths`: changed files do not map to any component.
- `missing_dependency_graph`: no dependency edges available for touched components.
- `low_confidence_edges`: low-confidence edges were included.

When `widening_reasons` is non-empty, `confidence` is `low`.

## CLI

```
mycelium cp blast --run <runId> --task <taskId>
```

If the artifact is missing, the CLI recomputes deterministically against the control-plane base SHA
for the current repo checkout.
