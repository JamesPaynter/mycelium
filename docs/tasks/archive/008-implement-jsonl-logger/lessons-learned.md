# Lessons Learned

## What went well
- Logger context defaults (run/task) kept events consistent without repeating metadata.

## What was tricky
- TypeScript recursion rules required explicit JsonArray type; payloads also needed to avoid undefined values.

## Unexpected discoveries
- Execa exit codes can be undefined, so log payloads need safe fallbacks to satisfy strict typing.

## Recommendations
- Keep log helpers responsible for timestamping and metadata to avoid scattered run_id handling.

## Time spent per phase
- Scoping: 0.25h
- Implementation: 1.0h
- Verification: 0.25h
- Review/Polish: 0.25h
