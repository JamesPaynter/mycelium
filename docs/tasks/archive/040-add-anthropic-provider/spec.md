# 040 — Add Anthropic provider (planner/validators)

## Status
- [x] Scoped
- [x] In Progress
- [x] Implemented
- [x] Verified

## Summary
Implement the Anthropic client behind the existing LLM abstraction so planner and validators can run on either provider via config.

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
- [x] Implement `AnthropicClient` behind the `llm/client.ts` abstraction.
- [x] Support structured output (JSON schema) and streaming if required.
- [x] Add config parsing for anthropic keys and model names.
- [x] Update docs with provider selection examples.

## Verification
- Manual: run planner in a dry-run mode with anthropic configured and confirm it produces valid JSON tasks. (Not run here; Anthropic credentials not available.)
- `npm test`
- `npm run build`

## Dependencies
### Blocks
- None

### Blocked by
- 021
