# Policy Artifacts (Autonomy Tiers)

Autonomy tiers classify tasks into a minimal 0-3 risk scale. The tier drives default
policy strictness (warn vs block) and check selection (scoped vs global).

## Tier semantics (MVP defaults)

- Tier 0: no surface change, low blast radius (single component).
- Tier 1: moderate blast radius (2-3 components), no surface change.
- Tier 2: any surface change, large blast radius (4+ components), or repo-root fallback.
- Tier 3: migration surface changes, config+contract combos, or repo-root fallback with wide impact.

## Behavior

- Checks: tiers 2/3 force global doctor commands even when scoped commands exist.
- Enforcement: when `manifest_enforcement=warn`, tiers 2/3 upgrade to `block`.
  `off` and `block` remain unchanged.

## Artifact location

Each task writes one JSON report at:

```
.mycelium/reports/control-plane/policy/<runId>/<taskId>.json
```

## Report shape

```json
{
  "tier": 2,
  "surface_change": true,
  "blast_radius": {
    "touched": 1,
    "impacted": 4,
    "confidence": "high"
  },
  "checks": {
    "mode": "enforce",
    "selected_command": "npm test",
    "rationale": ["surface_change:contract", "fallback:tier_high_risk"]
  },
  "locks": {
    "declared": {
      "reads": [],
      "writes": ["component:acme-web-app"]
    },
    "derived": {
      "reads": [],
      "writes": ["component:acme-web-app", "surface:acme-web-app"]
    }
  }
}
```

## Interpreting policy artifacts

Use the policy report alongside the other control-plane artifacts to explain a decision:

- `lock-derivation`: how write locks were derived from the manifest at the run base SHA.
- `blast`: diff-based blast radius for the task branch or workspace changes.
- `checkset`: scoped check selection, including fallback reasons and confidence.

`locks.derived` is only present when lock derivation is computed (lock mode `shadow` or `derived`).

## Reproduce with `cp policy eval`

To reproduce a decision locally, run the policy eval command with the run base SHA and the task diff:

```
mycelium cp policy eval \
  --repo <path> \
  --base-sha <sha> \
  --diff <base..head> \
  --manifest <path-to-task-manifest.json> \
  --json
```

If you omit `--manifest`, the CLI synthesizes a manifest from the diff paths.
If you pass `--config`, policy eval uses that config; otherwise it loads the repo config when present.
