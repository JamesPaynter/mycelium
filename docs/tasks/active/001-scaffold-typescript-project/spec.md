# 001 — Scaffold TypeScript project

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Create the baseline Node/TypeScript repository structure and build pipeline.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| package.json | add | Initialize npm package, scripts (build/typecheck), and dev dependencies. |
| tsconfig.json | add | TypeScript configuration for Node 20 target output to dist/. |
| src/index.ts | add | CLI entrypoint stub that prints help/usage placeholder. |
| .gitignore | add | Ignore dist/, node_modules/, logs/, and workspace directories. |
| README.md | add | Minimal project overview and local dev commands. |

## Blast Radius
- Scope: Repository bootstrap; affects all subsequent tasks and CI behavior.
- Risk level: Medium — wrong config choices can ripple through all code; easy to adjust early.
- Rollback: Revert commit(s) touching config files; regenerate with preferred tooling if needed.

## Implementation Checklist
- [ ] Create package.json with scripts: build, typecheck, start (optional).
- [ ] Add tsconfig.json with strict=true and outDir=dist.
- [ ] Create src/index.ts stub with basic argument parsing placeholder.
- [ ] Add .gitignore for generated artifacts.
- [ ] Document local setup in README.md.

## Verification
- `npm install`
- `npm run build`
- `node dist/index.js --help || true  # until CLI is implemented, ensure binary runs`

## Dependencies
### Blocks
- 002
- 003
- 004
- 008
- 014
- 020
- 022
- 024

### Blocked by
- None
