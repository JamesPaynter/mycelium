# Checkset Artifacts (Scoped Doctor)

Scoped checksets compute a per-task doctor command from the predicted component impact set.
When the checkset cannot be computed safely, the system falls back to the global doctor.

## Config

Add optional mapping under `control_graph.checks`:

```yaml
control_graph:
  checks:
    mode: report # off | report | enforce
    commands_by_component:
      component-a: npm run test:component-a
      component-b: npm run test:component-b
    max_components_for_scoped: 3
    # fallback_command: npm test
```

- `mode=off`: artifacts are still written for transparency, but behavior does not change.
- `mode=report`: write artifacts but keep the existing doctor command.
- `mode=enforce`: override `DOCTOR_CMD` per task when scoped checks are safe.

`commands_by_component` keys are component IDs (without the `component:` prefix).

## Safety fallbacks

The checkset falls back to the global doctor when:

- impact confidence is low (missing dependency graph or low-confidence edges)
- required components exceed `max_components_for_scoped`
- any required component is missing a mapping
- surface changes are detected but impact data is unavailable
- autonomy tiering flags a high-risk task (`tier_high_risk`)

When surface changes are detected and impact data is available, the checkset widens to the
impacted component set (reverse deps) and still respects the scoped component cap.
When the dependency graph is missing or low-confidence, impacted components widen to all
components; if that set is too large, the fallback triggers automatically.

Surface changes are filtered to tasks that touch the same components when ownership data
is available; otherwise the gate applies to all tasks.

## Artifact location

Each task writes one JSON report at:

```
.mycelium/reports/control-plane/checkset/<runId>/<taskId>.json
```

## Report shape

```json
{
  "task_id": "071",
  "task_name": "Scoped checkset computation",
  "required_components": ["component-a"],
  "selected_command": "npm run test:component-a",
  "surface_change": {
    "is_surface_change": true,
    "categories": ["contract"],
    "matched_files": {
      "contract": ["api/openapi.yaml"]
    },
    "matched_components": ["component-a"],
    "matched_components_by_category": {
      "contract": ["component-a"]
    }
  },
  "confidence": "high",
  "rationale": []
}
```

`fallback_reason` is present only when a fallback is used.
