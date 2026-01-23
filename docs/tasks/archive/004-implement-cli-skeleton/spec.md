# 004 — Implement CLI skeleton

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Add the top-level CLI with subcommand routing and global options.

## Model & Effort
- Effort: **M**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| src/index.ts | modify | Implement CLI parser and route to command handlers. |
| src/cli/plan.ts | add | plan subcommand stub with argument parsing. |
| src/cli/run.ts | add | run subcommand stub with argument parsing. |
| src/cli/resume.ts | add | resume subcommand stub with argument parsing. |
| src/cli/status.ts | add | status subcommand stub with argument parsing. |
| src/cli/logs.ts | add | logs subcommand stub with argument parsing. |
| src/cli/clean.ts | add | clean subcommand stub with argument parsing. |
| package.json | modify | Add bin entry (mycelium) and start script. |

## Blast Radius
- Scope: Command surface and user entrypoint for all functionality.
- Risk level: Medium — CLI breaking changes affect users; keep stable flags early.
- Rollback: Revert CLI wiring; keep command stubs for later.

## Implementation Checklist
- [x] Pick CLI library (e.g., commander) and implement root command.
- [x] Add subcommands and shared options: --project, --config, --verbose, --dry-run.
- [x] Ensure `--help` output renders and exits 0.
- [x] Add a bin mapping so `npx mycelium` or local install works.

## Verification
- `npm run build`
- `node dist/index.js --help`
- `node dist/index.js status --help`

## Dependencies
### Blocks
- 005
- 023

### Blocked by
- 001
