# Lessons Learned

## What went well
- Log index module stayed small and composable by keeping ingestion/query logic in one place.
- Optional flag on the logs command made it easy to add SQLite without breaking existing flows.

## What was tricky
- SQLite `ESCAPE` needed an explicit single-character literal; the first attempt triggered a SQL error.
- Type definitions for `better-sqlite3` were missing and blocked the build until added.

## Unexpected discoveries
- SQLite `LIKE` defaults to case-insensitive matches; enabling `case_sensitive_like` keeps behavior aligned with the grep-style search.

## Recommendations
- Consider a dedicated CLI entry for prebuilding the log index and exposing structured filters over more fields when the feature matures.

## Time spent per phase
- Scoping: 0.25h
- Implementation: 1.5h
- Verification: 0.5h
- Review/Polish: 0.25h
