# 022 — Add planner prompt templates

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Add prompt templates for planner and future validators with consistent structure and schema guidance.

## Model & Effort
- Effort: **S**
- Tier: **standard**

## Files Changing
| file | change type | description |
|---|---|---|
| templates/prompts/planner.md | add | Planner prompt template (from spec) with placeholders. |
| templates/prompts/test-validator.md | add | Test validator prompt template (future enhancement). |
| templates/prompts/doctor-validator.md | add | Doctor validator prompt template (future enhancement). |
| src/core/prompts.ts | add | Template loader and placeholder replacement helpers. |

## Blast Radius
- Scope: Quality and consistency of LLM outputs.
- Risk level: Low — templates are static and easily versioned.
- Rollback: Inline prompts in code while templates are stabilized.

## Implementation Checklist
- [x] Create templates with placeholders: project_name, repo_path, resources, implementation_plan, etc.
- [x] Add helper to load template files and substitute placeholders safely.
- [x] Ensure templates are included in npm package (files field) if publishing.

## Verification
- `npm test`
- `Manual: load planner template and confirm placeholders are replaced (print in dry-run).`

## Dependencies
### Blocks
- 023
- 025
- 026

### Blocked by
- 001
