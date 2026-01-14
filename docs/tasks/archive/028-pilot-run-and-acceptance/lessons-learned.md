# Lessons learned — 028 Pilot run + acceptance checklist

- Local worker mode is essential for environments without Docker; passing CODEX/OPENAI env into CodexRunner prevents 401s.
- Doctor commands are brittle to CLI entrypoints; keeping the runner in a script (`node ./scripts/run-tests.js --runInBand`) avoided Vitest flag parsing errors.
- Keep fail-once/diagnostic files outside the repo (CODEX_HOME) so integration doctor and git cleanliness are unaffected.
