#!/usr/bin/env bash
set -euo pipefail

QUEUE="${QUEUE:-scripts/lint-queue.tsv}"
MAX_ITERS="${MAX_ITERS:-999}"
CODEX_CMD="${CODEX_CMD:-}"
LINT_CMD="${LINT_CMD:-npx eslint}"
SKIP_LINT="${SKIP_LINT:-1}"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
CODEX_TTY="${CODEX_TTY:-1}"

if [[ -z "$CODEX_CMD" ]]; then
  echo "Set CODEX_CMD to the command that launches Codex and reads prompt from STDIN." >&2
  echo 'Example: CODEX_CMD="codex --stdin"' >&2
  exit 1
fi

run_codex() {
  if [[ "$CODEX_TTY" == "1" ]]; then
    if ! command -v script >/dev/null 2>&1; then
      echo "The 'script' command is required for CODEX_TTY=1." >&2
      exit 1
    fi
    eval "script -q /dev/null $CODEX_CMD"
  else
    eval "$CODEX_CMD"
  fi
}

if [[ ! -f "$QUEUE" ]]; then
  echo "Queue not found: $QUEUE" >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY" != "1" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Set ALLOW_DIRTY=1 to proceed." >&2
  exit 1
fi

for _ in $(seq 1 "$MAX_ITERS"); do
  line="$(awk -F $'\t' '$1=="todo" {print; exit}' "$QUEUE" || true)"
  if [[ -z "$line" ]]; then
    echo "No remaining TODO items in $QUEUE"
    exit 0
  fi

  IFS=$'\t' read -r status task_id files rules last_commit note <<< "$line"
  IFS=',' read -ra file_list <<< "$files"
  lint_targets="${file_list[*]}"

  echo "Starting Codex for ${task_id} (${files})"
  if ! cat <<EOF | run_codex
You are in the repo at $(pwd).

Fix ESLint warnings for the following file(s) only:
$(printf -- "- %s\n" "${file_list[@]}")

Target rules: ${rules}

Constraints:
- Only edit the files listed above.
- Do not change behavior.
- Do not commit.

Goal: remove the lint warnings for these files.
No need to run lint; the loop is running in fast mode.
EOF
  then
    echo "Codex command failed." >&2
    exit 1
  fi

  if [[ "$SKIP_LINT" != "1" ]]; then
    lint_output="$($LINT_CMD "${file_list[@]}" --format unix || true)"
    if [[ -n "$lint_output" ]]; then
      echo "Lint still failing for ${files}:" >&2
      echo "$lint_output" >&2
      exit 1
    fi
    python3 scripts/lint-queue-update.py "$QUEUE" "$task_id" "done" "" "clean"
  else
    python3 scripts/lint-queue-update.py "$QUEUE" "$task_id" "done" "" "skipped-lint"
  fi

  git add -A
  if git diff --cached --quiet; then
    echo "No changes to commit for ${task_id}." >&2
    exit 1
  fi

  git commit -m "[STYLE] lint loop ${task_id}"
  echo "Committed ${task_id}. Restarting loop..."

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree not clean after commit. Aborting." >&2
    exit 1
  fi
done
