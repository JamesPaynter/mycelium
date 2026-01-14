# Lessons learned

- Keep runtime state under `.task-orchestrator/` and ensure it is ignored so automatic commits stay clean.
- Persisting CODEX_HOME inside the workspace simplifies container restarts because thread sessions and worker state travel together.
