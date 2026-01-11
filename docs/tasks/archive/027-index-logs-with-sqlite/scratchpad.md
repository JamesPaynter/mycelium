# 2026-01-10

## Notes

# 2026-01-11

## Commands
- `npm install better-sqlite3`
- `npm test` (failed: SQLite ESCAPE needed single character)
- `npm test` (pass after adjusting ESCAPE)
- `npm run build` (failed: missing @types/better-sqlite3)
- `npm install --save-dev @types/better-sqlite3`
- `npm run build`

## Notes
- Added SQLite log index with unique constraint per run/source/line for idempotent ingestion.
- Adjusted ESCAPE clause to use a single backslash; earlier version triggered SQLite error.
- Tests cover indexed queries (task/type glob/search) and idempotent re-ingestion.
