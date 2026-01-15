# Lessons learned

- Anthropic structured outputs work reliably by forcing a single tool call with an object schema; enforce `type: object` before sending.
- Exposing config-level Anthropic auth/base URL fields keeps provider switches predictable for planners and validators.
