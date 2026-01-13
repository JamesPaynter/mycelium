#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# PATHS
# =============================================================================

# where this script lives
SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"

# where the project being worked on lives
PROJECT_DIR="${PROJECT_DIR:-"$SCRIPT_DIR/YOUR_PROJECT"}"

# instructions get fed to the agent each loop
INSTRUCTIONS_FILE="${INSTRUCTIONS_FILE:-"$PROJECT_DIR/INSTRUCTIONS.md"}"

# loop stops when this pattern appears in this file
DONE_FILE="${DONE_FILE:-"$PROJECT_DIR/TODO.md"}"
DONE_PATTERN="${DONE_PATTERN:-\\[x\\] ALL_TASKS_COMPLETE}"

# =============================================================================
# LOOP SETTINGS
# =============================================================================

SLEEP_SECONDS="${SLEEP_SECONDS:-2}"
MAX_LOOPS="${MAX_LOOPS:-0}"  # 0 = run until done

# output modes:
#   stream   - print to terminal (default)
#   quiet    - discard output
#   log      - print to terminal AND save to file
#   log_only - save to file only
STDOUT_MODE="${STDOUT_MODE:-stream}"
LOG_DIR="${LOG_DIR:-"$SCRIPT_DIR/logs"}"

# =============================================================================
# DOCKER / CODEX
# =============================================================================

IMAGE="${IMAGE:-agent-loop:latest}"

# API key auth (optional - if not set, uses cached login from codex_home volume)
# convenience: OPENAI_API_KEY works as an alias for CODEX_API_KEY
[[ -z "${CODEX_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]] && export CODEX_API_KEY="$OPENAI_API_KEY"

# =============================================================================
# ARGS
# =============================================================================

DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --once) MAX_LOOPS=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# =============================================================================
# FUNCTIONS
# =============================================================================

check_done() {
  [[ -f "$DONE_FILE" ]] && grep -qE "$DONE_PATTERN" "$DONE_FILE"
}

run_agent() {
  docker run -i --rm \
    -v codex_home:/root/.codex \
    -v "$PROJECT_DIR:/workspace" \
    -w /workspace \
    ${CODEX_API_KEY:+-e CODEX_API_KEY} \
    "$IMAGE" \
    codex exec \
      --model gpt-5.1-codex-max \
      -c model_reasoning_effort=xhigh \
      --dangerously-bypass-approvals-and-sandbox \
      --skip-git-repo-check \
      - < "$INSTRUCTIONS_FILE"
}

run_with_output() {
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  
  case "$STDOUT_MODE" in
    stream)
      run_agent
      ;;
    quiet)
      run_agent >/dev/null 2>&1
      ;;
    log)
      mkdir -p "$LOG_DIR"
      run_agent 2>&1 | tee "$LOG_DIR/run-$ts.log"
      ;;
    log_only)
      mkdir -p "$LOG_DIR"
      run_agent >"$LOG_DIR/run-$ts.log" 2>&1
      ;;
    *)
      echo "Unknown STDOUT_MODE: $STDOUT_MODE" >&2
      exit 1
      ;;
  esac
}

# =============================================================================
# MAIN
# =============================================================================

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "project:      $PROJECT_DIR"
  echo "instructions: $INSTRUCTIONS_FILE"
  echo "done file:    $DONE_FILE"
  echo "done pattern: $DONE_PATTERN"
  echo "image:        $IMAGE"
  echo "output:       $STDOUT_MODE"
  echo "auth:         ${CODEX_API_KEY:+API key}${CODEX_API_KEY:-cached login}"
  exit 0
fi

loops=0
while true; do
  run_with_output
  ((loops++))

  if check_done; then
    echo "Done. ($loops loops)"
    exit 0
  fi

  if [[ "$MAX_LOOPS" -gt 0 && "$loops" -ge "$MAX_LOOPS" ]]; then
    echo "Max loops reached. ($loops)"
    exit 0
  fi

  sleep "$SLEEP_SECONDS"
done
