# Lessons Learned

## What went well
- Centralized state transitions made executor updates clearer and kept attempts/timestamps consistent.

## What was tricky
- Ensuring atomic writes stayed on the same filesystem; needed to anchor temp paths to the target directory.

## Unexpected discoveries
- Resume flow already relied on ad-hoc resets; consolidating into `resetRunningTasks` simplified crash recovery logic.

## Recommendations
- Prefer `StateStore.save/load` for any future state mutations to keep `updated_at` and schema validation consistent.

## Time spent per phase
- Scoping: 0.2h
- Implementation: 1.6h
- Verification: 0.3h
- Review/Polish: 0.2h
