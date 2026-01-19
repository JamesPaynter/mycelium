# Lessons learned — 049 — Docs parity and spec rebaseline

- What worked: Converging the docs into status tables made the implemented vs future story easy to scan and avoided conflicting narratives between README/spec/spec-updates.
- What didn’t: Test run initially failed on this arm64 host due to missing native deps (`@rollup/...` and `better-sqlite3`); needed a quick reinstall/rebuild before Vitest.
- Follow-ups: Consider adding a short "platform prep" note near the CLI/dev instructions so future arm64 runs include the native module rebuild upfront.
