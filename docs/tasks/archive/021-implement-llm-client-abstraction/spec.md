# 021 — Implement LLM client abstraction

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Introduce a provider-agnostic LLM interface used by planner and future validators.

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
| file | change type | description |
|---|---|---|
| src/llm/client.ts | add | Provider-agnostic interface and shared request/response types. |
| src/llm/openai.ts | add | OpenAI implementation (chat/completions) with structured output support. |
| src/core/config.ts | modify | Add planner/test_validator/doctor_validator model config typing. |
| src/llm/client.test.ts | add | Unit tests with mocked HTTP transport. |

## Blast Radius
- Scope: Planner/validator reliability and future extensibility.
- Risk level: Medium — API churn and auth handling; keep well-isolated.
- Rollback: Keep LLM integration behind a feature flag; fallback to stubbed planner output.

## Implementation Checklist
- [x] Define client interface: complete(prompt, schema?, temperature?, timeout?).
- [x] Add OpenAI client with API key from env and request retries/backoff.
- [x] Ensure deterministic mode available (temperature=0) for validators.
- [x] Add tests for request shaping and error mapping.

## Verification
- `npm test`
- `Manual: run a no-op call in dry-run mode with missing key and confirm error message is actionable.`

## Dependencies
### Blocks
- 023
- 025
- 026

### Blocked by
- 005
