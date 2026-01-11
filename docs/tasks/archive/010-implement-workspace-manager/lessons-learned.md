# Lessons Learned

## What went well
- Workspace manager logic stayed small by reusing git helpers and shared path utilities.
- Tests using local bare repos provided fast feedback without external dependencies.

## What was tricky
- Normalizing and validating existing workspaces needed careful handling to avoid false positives.
- Git fixtures required explicit user identity to allow commits during tests.

## Unexpected discoveries
- Without cleanup between tests, shared workspace paths can leak state and trigger reuse validation errors.

## Recommendations
- Consider centralizing git test fixture helpers to reduce repetition across future tests.

## Time spent per phase
- Scoping: ~10m
- Implementation: ~60m
- Verification: ~15m
- Review/Polish: ~10m
