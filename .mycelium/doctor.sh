#!/usr/bin/env bash
set -euo pipefail

if [[ "${ORCH_CANARY:-}" == "1" ]]; then
  echo "ORCH_CANARY=1: failing as expected"
  exit 1
fi

npm run typecheck
npm run build
npm test
