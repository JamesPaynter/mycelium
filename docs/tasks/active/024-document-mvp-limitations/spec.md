# 024 — Document MVP limitations

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Document the MVP scope and clarified behaviors (workspace isolation, resume level, validators) in project docs.

## Model & Effort
- Effort: **XS**
- Tier: **mini**

## Files Changing
| file | change type | description |
|---|---|---|
| README.md | modify | Add MVP scope notes and non-goals for current release. |
| docs/mvp-scope.md | add | Explicit scope: Level 1 resume, no validator gating, informational access events. |

## Blast Radius
- Scope: Documentation only; aligns expectations for users and contributors.
- Risk level: Low.
- Rollback: Revert doc changes.

## Implementation Checklist
- [ ] Document workspace isolation via per-task clones.
- [ ] Document resume semantics (running -> pending on resume).
- [ ] Document validators as future enhancements (non-blocking).

## Verification
- `Manual: review docs for consistency with spec corrections.`

## Dependencies
### Blocks
- None

### Blocked by
- 001
