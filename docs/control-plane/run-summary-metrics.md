# Run Summary Metrics

Each orchestrator run emits a JSON summary artifact with run-level metrics.
Use the summary to compare derived lock modes, scope enforcement impact, and validation overhead.

## Artifact location

```
.mycelium/reports/control-plane/run-summary/<runId>.json
```

## Report shape

```json
{
  "run_id": "20240101-120000",
  "project": "acme-web",
  "status": "complete",
  "started_at": "2024-01-01T12:00:00.000Z",
  "completed_at": "2024-01-01T12:12:34.000Z",
  "control_plane": {
    "enabled": true,
    "lock_mode": "derived",
    "scope_mode": "enforce"
  },
  "metrics": {
    "scope_violations": { "warn_count": 0, "block_count": 1 },
    "fallback_repo_root_count": 2,
    "avg_impacted_components": 3.5,
    "doctor_seconds_total": 42.318,
    "checkset_seconds_total": 18.104,
    "derived_lock_mode_enabled": true,
    "avg_batch_size": 2.0
  }
}
```

## Metric notes

- `scope_violations.*_count`: total violations recorded during manifest compliance (warn/block).
- `fallback_repo_root_count`: tasks with low-confidence derived scope that include the fallback resource.
- `avg_impacted_components`: average impacted component count across blast radius reports.
- `doctor_seconds_total`: total time spent in doctor validations (integration runs + validator).
- `checkset_seconds_total`: total time spent running scoped test validators.
- `derived_lock_mode_enabled`: true when the effective lock mode is `derived`.
- `avg_batch_size`: average number of tasks per scheduled batch.

When the control plane is disabled, derived-scope/blast metrics remain present but will be 0.
Validation timing and batch size still reflect the run.
