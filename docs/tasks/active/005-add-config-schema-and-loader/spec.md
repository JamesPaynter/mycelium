# 005 — Add config schema and loader

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Load and validate project YAML config files with sensible defaults and errors.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/core/config.ts | add | Define ProjectConfig types, defaults, and validation. |
| src/core/config-loader.ts | add | Load YAML config and resolve env vars. |
| projects/example.yaml | add | Example project config file. |
| src/cli/* | modify | Wire commands to load config via --project/--config. |

## Blast Radius
- Scope: All commands depend on reliable config loading.
- Risk level: Medium — mis-validated config can cause runtime failures.
- Rollback: Fallback to permissive parsing; reduce validation strictness.

## Implementation Checklist
- [ ] Define ProjectConfig type and validate required keys (repo_path, main_branch, doctor, resources).
- [ ] Support optional keys: task_branch_prefix, max_parallel, max_retries, bootstrap, docker.image, etc.
- [ ] Implement YAML loader and env var substitution (${VAR}).
- [ ] Return actionable error messages (file, key path, expected type).
- [ ] Add example.yaml aligned with the spec.

## Verification
- `node dist/index.js status --project example --help`
- `node dist/index.js status --project example --dry-run || true  # command may be stubbed; ensure config loads`

## Dependencies
### Blocks
- 006
- 010
- 013
- 021
- 023

### Blocked by
- 004
