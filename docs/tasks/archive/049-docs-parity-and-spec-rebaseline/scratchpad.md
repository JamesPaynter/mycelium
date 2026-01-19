# Scratchpad — 049 — Docs parity and spec rebaseline

- 2026-01-19
  - Notes: Rebuilt README + planning docs with implemented/future tables; added runtime reality section to spec; rewrote compliance/validator sections; restored docs/mvp-scope as current scope.
  - Commands:
    - `npm test` (failed: missing @rollup/rollup-linux-arm64-gnu)
    - `npm install @rollup/rollup-linux-arm64-gnu@4.55.1 --no-save`
    - `npm rebuild better-sqlite3`
    - `npm test`
    - `npm run build`
  - Decisions: Keep manifest/validator/budget behaviors explicit in tables; highlight best-effort resume + log index tooling in README and spec.
