# Lessons Learned

## What went well
- Injecting a transport layer kept the OpenAI client testable without network calls.
- Shared option types (temperature/timeout/schema) make future validators easy to wire.

## What was tricky
- The OpenAI SDK returns a streaming union by default, so the transport needed a guard/cast to keep typings strict.

## Unexpected discoveries
- Defaulting to temperature=0 is a useful deterministic baseline even when configs omit it.

## Recommendations
- Reuse the content-extraction helper when adding Anthropic/Codex adapters to avoid scattered parsing code.

## Time spent per phase
- Scoping: 0.3h
- Implementation: 1.0h
- Verification: 0.3h
- Review/Polish: 0.2h
