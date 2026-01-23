# Surface Change Detection (MVP)

Surface change detection flags high-risk files that usually require wider verification
(contracts, config, migrations, and public entrypoints). The detector is pattern-based
and uses git diffs between the run base SHA and the current repo state.

## Categories

- `contract`: API contracts and schemas (OpenAPI, protobuf, GraphQL, AsyncAPI).
- `config`: environment/config files, infra manifests, and Helm values.
- `migration`: schema or data migration folders.
- `public-entrypoint`: package entrypoints (`index.ts`) and export maps (`package.json`).

## Default patterns

```yaml
control_plane:
  surface_patterns:
    contract:
      - "**/openapi.*"
      - "**/*.proto"
      - "**/asyncapi.*"
      - "**/*.graphql"
      - "**/schema.*"
    config:
      - ".env*"
      - "**/.env*"
      - "**/config/**"
      - "**/*config*.*"
      - "**/k8s/**"
      - "**/kubernetes/**"
      - "**/helm/**"
      - "**/values*.yaml"
      - "**/values*.yml"
    migration:
      - "**/migrations/**"
      - "**/*migration*/**"
    public-entrypoint:
      - "**/index.ts"
      - "**/package.json"
```

Notes:
- Patterns are minimatch globs evaluated against repo-relative paths.
- Omit a category to use the defaults; set an empty list to disable that category.

## Component association

When a control-plane model is available, matched files are mapped to component IDs.
This allows surface gating to apply only to tasks touching those components.

## Output shape

```json
{
  "is_surface_change": true,
  "categories": ["contract", "config"],
  "matched_files": {
    "contract": ["api/openapi.yaml"],
    "config": [".env.local", "deploy/values.yaml"]
  },
  "matched_components": ["component-a", "component-b"],
  "matched_components_by_category": {
    "contract": ["component-a"],
    "config": ["component-b"]
  }
}
```
