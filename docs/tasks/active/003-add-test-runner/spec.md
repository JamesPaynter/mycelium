# 003 — Add unit test runner

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Add a unit-test framework and a minimal smoke test to validate the toolchain.

## Model & Effort
- Effort: **S**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| package.json | modify | Add test script and test framework dev dependencies. |
| src/__tests__/smoke.test.ts | add | Basic test verifying build/test pipeline works. |
| tsconfig.json | modify | Add test-specific config or references if required. |

## Blast Radius
- Scope: Automated verification foundation for subsequent modules.
- Risk level: Low — new tooling; limited functional impact.
- Rollback: Remove test deps and test folder; restore scripts.

## Implementation Checklist
- [x] Select and install test runner (e.g., Vitest or Jest) and TS support.
- [x] Add a minimal smoke test.
- [x] Wire npm test script.

## Verification
- `npm test`

## Dependencies
### Blocks
- None

### Blocked by
- 001
