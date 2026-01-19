#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_REPO="$ROOT_DIR/test/fixtures/toy-repo"
TEMP_DIR="$(mktemp -d -t mycelium-docker-smoke-XXXXXX)"
RUN_ID="${RUN_ID:-docker-smoke-$(date +%s)}"
PROJECT_NAME="docker-smoke"
DOCKERFILE="$ROOT_DIR/templates/Dockerfile"
BUILD_CONTEXT="$ROOT_DIR"
REPO_COPY="$TEMP_DIR/repo"
CONFIG_PATH="$TEMP_DIR/project.yaml"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the smoke test (docker info failed)." >&2
  exit 1
fi

echo "Preparing fixture repo in $REPO_COPY"
cp -R "$FIXTURE_REPO" "$REPO_COPY"

pushd "$REPO_COPY" >/dev/null
git init
git config user.email "docker-e2e@example.com"
git config user.name "Docker E2E Tester"
git add -A
git commit -m "initial"
git checkout -B main
popd >/dev/null

cat >"$CONFIG_PATH" <<EOF
repo_path: $REPO_COPY
main_branch: main
tasks_dir: .mycelium/tasks
doctor: npm test
max_parallel: 1
resources:
  - name: docs
    paths: ["notes/**"]
  - name: code
    paths: ["src/**"]
planner:
  provider: mock
  model: mock
worker:
  model: mock
docker:
  image: mycelium-worker:test
  dockerfile: $DOCKERFILE
  build_context: $BUILD_CONTEXT

EOF

export MYCELIUM_HOME="$TEMP_DIR/.mycelium"
export MOCK_LLM=1
export MOCK_LLM_OUTPUT_PATH="$REPO_COPY/mock-planner-output.json"

echo "Planning tasks with mock LLM..."
npx tsx "$ROOT_DIR/src/main.ts" plan --config "$CONFIG_PATH" --project "$PROJECT_NAME" --input .mycelium/planning/implementation-plan.md

echo "Running Docker smoke (run id: $RUN_ID)..."
npx tsx "$ROOT_DIR/src/main.ts" run --config "$CONFIG_PATH" --project "$PROJECT_NAME" --max-parallel 1 --run-id "$RUN_ID"

echo "Run complete. Logs: $MYCELIUM_HOME/logs/$PROJECT_NAME/run-$RUN_ID"
