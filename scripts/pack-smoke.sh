#!/usr/bin/env bash

set -euo pipefail

# Smoke-test npm pack + install to ensure CLI and templates ship correctly.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR="$(mktemp -d -t mycelium-pack-smoke-XXXXXX)"
TARBALL=""
PACKAGE_ROOT=""

cleanup() {
  if [[ -n "$TARBALL" && -f "$ROOT_DIR/$TARBALL" ]]; then
    rm -f "$ROOT_DIR/$TARBALL"
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Building dist artifacts..."
pushd "$ROOT_DIR" >/dev/null
npm run build

echo "Packing module..."
PACK_OUTPUT="$(npm pack --json)"
TARBALL="$(node -e "const out = JSON.parse(process.argv[1]); if (!Array.isArray(out) || !out[0] || !out[0].filename) { throw new Error('npm pack output missing filename'); } console.log(out[0].filename);" "$PACK_OUTPUT")"

mv "$ROOT_DIR/$TARBALL" "$TEMP_DIR/"
popd >/dev/null

echo "Installing tarball into temp project at $TEMP_DIR"
pushd "$TEMP_DIR" >/dev/null
npm init -y >/dev/null
npm install "./$TARBALL" >/dev/null
PACKAGE_ROOT="$TEMP_DIR/node_modules/mycelium"

echo "Verifying packaged templates and binaries..."
for required in \
  "bin/mycelium" \
  "dist/index.js" \
  "dist/worker/index.js" \
  "dist/ui/index.html" \
  "dist/ui/styles.css" \
  "dist/ui/app.js" \
  "dist/ui/views/list.js" \
  "dist/ui/views/garden.js" \
  "dist/ui/views/map.js" \
  "templates/Dockerfile" \
  "templates/codex-config.toml" \
  "templates/codex/config-worker.toml" \
  "templates/codex/config-planner.toml" \
  "templates/prompts/planner.md" \
  "templates/prompts/test-validator.md" \
  "templates/prompts/doctor-validator.md"; do
  if [[ ! -f "$PACKAGE_ROOT/$required" ]]; then
    echo "Missing packaged file: $required" >&2
    exit 1
  fi
done

echo "Running CLI smoke checks..."
npx --prefix "$TEMP_DIR" mycelium --help >/dev/null
npx --prefix "$TEMP_DIR" mycelium plan --help >/dev/null

echo "Pack/install smoke succeeded."
echo "Tarball location: $TEMP_DIR/$TARBALL"
popd >/dev/null
