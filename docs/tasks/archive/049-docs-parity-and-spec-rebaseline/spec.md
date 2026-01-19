# 049 — Docs parity and spec rebaseline

## Status
- [x] Ready
- [x] In progress
- [ ] In review
- [x] Done

## Summary
Update the documentation to accurately reflect what the codebase *currently* implements, and reconcile
the “initial planning documents” with the actual runtime behavior (autopilot → plan → run → resume, blocking validators, resume L2/L3, budgets, log indexing, strict TDD).

## Scope
- Reconcile `README.md` “known gaps” / “what’s implemented” sections with the code paths that exist today.
- Update the planning docs (`planning-docs/spec.md`, `planning-docs/spec-updates.md`, and `planning-docs/spec-compliance-checklist.md`) so they clearly distinguish:
  - **Spec goals** (design intent)
  - **Implemented** (in this repo)
  - **Not implemented / future**
- Update `docs/mvp-scope.md` so it is either:
  - renamed/archived as “historical MVP scope”, or
  - rewritten as “current scope” (preferred).
- Ensure docs consistently describe:
  - How planning is done (autopilot vs manual)
  - What resume does (reattach running containers, reuse worker-state thread id, etc.)
  - Validator modes (off/warn/block) and merge gating behavior
  - Manifest enforcement + auto-rescope behavior

## Out of scope
- Adding new runtime features (this task is documentation + clarification only).
- Building a web UI.

## Acceptance criteria
- README no longer claims limitations that are contradicted by the implementation.
- Planning docs/spec-updates no longer describe already-implemented features as “future”.
- A newcomer can follow docs and successfully execute **one full end-to-end run** using autopilot, without needing to consult code.

## Likely files / areas to change
- README.md
- planning-docs/spec.md
- planning-docs/spec-updates.md
- planning-docs/spec-compliance-checklist.md
- docs/mvp-scope.md
- (optional) docs/ops/* for concrete runbooks

## Implementation notes
- Treat this as “docs as a contract”: align terminology with emitted log events (e.g., `container.reattach`, `codex.thread.resumed`, `validation.*`, `manifest.*`).
- Prefer tables/matrices over prose for the “Implemented vs Not” mapping.

## Verification
- Run `npm test` and ensure no docs references are broken (links/paths correct).
- Perform a manual doc walkthrough: follow README steps to complete an autopilot run on the fixture repo.
