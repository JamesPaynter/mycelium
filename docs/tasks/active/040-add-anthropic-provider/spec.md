# 040 — Add Anthropic provider (planner/validators)

## Status
- [x] Scoped
- [ ] In Progress
- [ ] Implemented
- [ ] Verified

## Summary
Implement the Anthropic client behind the existing LLM abstraction so planner and validators can run on either provider via config.

## Model & Effort
- Effort: **M**
- Tier: **standard**

## Files Changing
...
- [ ] Implement `AnthropicClient` behind the `llm/client.ts` abstraction.
- [ ] Support structured output (JSON schema) and streaming if required.
- [ ] Add config parsing for anthropic keys and model names.
- [ ] Update docs with provider selection examples.

## Verification
- Manual: run planner in a dry-run mode with anthropic configured and confirm it produces valid JSON tasks.
- `npm test`

## Dependencies
### Blocks
- None

### Blocked by
- 021
