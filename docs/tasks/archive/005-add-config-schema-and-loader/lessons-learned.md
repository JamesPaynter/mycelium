# Lessons Learned

## What went well
- Splitting the schema from the loader kept validation logic simple and testable.

## What was tricky
- Settling on path resolution rules required care to avoid surprising defaults for Docker paths.

## Unexpected discoveries
- The example config needed explicit absolute Docker paths once resolution anchored to the config file.

## Recommendations
- Keep config path resolution rules documented alongside the loader to avoid regressions.

## Time spent per phase
- Scoping: 0.25h
- Implementation: 1h
- Verification: 0.25h
- Review/Polish: 0.25h
