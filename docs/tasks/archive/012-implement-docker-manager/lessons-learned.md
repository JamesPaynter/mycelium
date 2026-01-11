# Lessons Learned

## What went well
Fake Docker containers kept tests fast and easy to reason about.

## What was tricky
Docker stream demuxing needed careful handling without a real daemon.

## Unexpected discoveries
Sharing the JSONL parsing helper avoided duplicated logging code.

## Recommendations
Use the Jsonl logger helper for any future streaming to keep log formats consistent.

## Time spent per phase
- Scoping: 0.5h
- Implementation: 1.5h
- Verification: 0.3h
- Review/Polish: 0.2h
