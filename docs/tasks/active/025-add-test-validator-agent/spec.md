# 025 — Add test validator agent (non-blocking)

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Implement optional test-quality validation that emits warnings/reports without blocking merges (future-friendly).

## Model & Effort
- Effort: **M**
- Tier: **pro**

## Files Changing
| file | change type | description |
|---|---|---|
| src/validators/test-validator.ts | add | LLM-driven test quality analysis (non-blocking) with JSON output. |
| src/core/executor.ts | modify | Invoke test validator after task completion when enabled. |
| src/core/config.ts | modify | Add test_validator enabled/provider/model options. |
| templates/prompts/test-validator.md | modify | Ensure prompt includes output schema and quality checks. |

## Blast Radius
- Scope: Post-task assessment; impacts speed/cost but not functional execution when non-blocking.
- Risk level: Medium — false positives/negatives; keep advisory mode first.
- Rollback: Disable via config; skip invocation entirely.

## Implementation Checklist
- [ ] Implement validator invocation gated by config.enabled.
- [ ] Collect changed test files and relevant code context (best-effort heuristics).
- [ ] Call LLM with temperature=0 and parse JSON schema output.
- [ ] Write validator JSONL events and a per-task report file.

## Verification
- `Manual: run validator in mock mode (fixture inputs) and confirm JSON schema parsing.`
- `npm test`

## Dependencies
### Blocks
- None

### Blocked by
- 021
- 022
- 015
