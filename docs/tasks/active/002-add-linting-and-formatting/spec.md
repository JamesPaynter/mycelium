# 002 — Add linting and formatting

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Introduce ESLint + Prettier (or equivalent) and wire into npm scripts.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| .eslintrc.cjs | add | ESLint config for TypeScript, Node, and import rules. |
| .prettierrc | add | Prettier formatting rules. |
| package.json | modify | Add scripts: lint, format, format:check; add dev deps. |
| README.md | modify | Document lint/format commands. |

## Blast Radius
- Scope: Developer workflow and CI checks (lint/format).
- Risk level: Low — isolated to tooling; can be tuned without functional impact.
- Rollback: Remove ESLint/Prettier config + deps; restore previous scripts.

## Implementation Checklist
- [ ] Add ESLint configuration (TypeScript parser, recommended rules).
- [ ] Add Prettier config and ensure ESLint integrates cleanly (eslint-config-prettier).
- [ ] Wire npm scripts for lint and formatting.
- [ ] Ensure baseline code passes lint.

## Verification
- `npm run lint`
- `npm run format:check || npm run format`

## Dependencies
### Blocks
- None

### Blocked by
- 001
