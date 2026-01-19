# Lessons learned — 053 — Template & packaging cleanup (reduce ambiguity)

- What worked:
  - Picking a single worker Dockerfile removed config guessing and aligned docs/config defaults.
  - Pack smoke script with explicit file assertions gives fast confidence the npm tarball ships templates and binaries.
- What didn’t:
  - Nothing unexpected; pack flow relies on a fresh build each run but stayed quick enough.
- Follow-ups:
  - Wire the pack smoke script into CI so packaging regressions fail quickly.
