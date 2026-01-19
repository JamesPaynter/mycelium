# Scratchpad — 053 — Template & packaging cleanup (reduce ambiguity)

- Notes:
  - 2026-01-19: Canonical worker Dockerfile is `templates/Dockerfile`; removed `templates/worker.Dockerfile` to avoid ambiguity.
  - 2026-01-19: Added `scripts/pack-smoke.sh` to pack/install in a temp project and assert templates + binaries ship.
- Links:
- Decisions:
  - Documented worker image build path in README and tied `npm run docker:build-worker` to `templates/Dockerfile`.
  - Keep templates packaged via `package.json#files` and validate presence in the pack smoke script.
- Commands:
  - npm run build
  - npm test
  - npm run pack:smoke
