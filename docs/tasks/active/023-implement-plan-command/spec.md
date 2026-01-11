# 023 — Implement plan command

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Implement `plan` to convert an implementation-plan.md into .tasks/ manifests and specs via LLM.

## Model & Effort
- Effort: **L**
- Tier: **standard**

## Files Changing
| file | change type | description |
|---|---|---|
| src/cli/plan.ts | modify | Read implementation plan, call planner, write .tasks outputs. |
| src/core/planner.ts | add | Planner orchestration (prompt build, schema validation, error handling). |
| src/core/task-writer.ts | add | Write manifest.json + spec.md to .tasks/<id>-<name>/ |
| src/core/task-manifest.ts | modify | Expose writer-friendly normalization for ids/names. |
| README.md | modify | Document plan usage and required env vars. |

## Blast Radius
- Scope: Task generation; affects subsequent run scheduling and correctness.
- Risk level: High — bad planner output can create invalid tasks; must validate aggressively.
- Rollback: Allow `--dry-run` and `--output` to write elsewhere; require human review before run.

## Implementation Checklist
- [ ] Implement plan CLI flags: --input, --output, --dry-run, --project.
- [ ] Load implementation plan markdown and project resources from config.
- [ ] Build planner prompt from template and call LLM with output schema.
- [ ] Validate tasks: unique ids, kebab-case names, locks map to resources, verify commands present.
- [ ] Write files: .tasks/<id>-<name>/manifest.json and spec.md; also write a manifest index if useful.

## Verification
- `Manual: run plan in --dry-run and ensure it prints the task count and ids.`
- `Manual: run plan against a small toy plan and confirm files are written under .tasks/.`

## Dependencies
### Blocks
- None

### Blocked by
- 004
- 005
- 021
- 022
- 006
