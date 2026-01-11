# Lessons Learned

## What went well
Isolated the bootstrap runner behind a small helper and exercised it with fake Docker results, which kept tests quick and deterministic.

## What was tricky
Balancing logging detail with truncated output so bootstrap failures are debuggable without ballooning log files.

## Unexpected discoveries
Bootstrap config already existed in the schema and executor; giving it a default required tightening the env propagation path.

## Recommendations
Consider wiring the new bootstrap runner into the executor flow and de-duplicating bootstrap handling in the worker entrypoint.

## Time spent per phase
- Scoping: 10m
- Implementation: 50m
- Verification: 10m
- Review/Polish: 10m
