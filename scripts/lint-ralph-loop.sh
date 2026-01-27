#!/usr/bin/env bash
set -euo pipefail

QUEUE="${QUEUE:-scripts/lint-queue.tsv}"
PROMPT_DIR="${PROMPT_DIR:-scripts/lint-prompts}"
MAX_ITERS="${MAX_ITERS:-999}"
CODEX_CMD="${CODEX_CMD:-}"
LINT_CMD="${LINT_CMD:-npx eslint}"
SKIP_LINT="${SKIP_LINT:-1}"

if [[ -z "$CODEX_CMD" ]]; then
  echo "Set CODEX_CMD to the command that launches Codex and reads prompt from STDIN." >&2
  echo 'Example: CODEX_CMD="codex --stdin"' >&2
  exit 1
fi

if [[ ! -f "$QUEUE" ]]; then
  echo "Queue not found: $QUEUE" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before running the loop." >&2
  exit 1
fi

mkdir -p "$PROMPT_DIR"

for _ in $(seq 1 "$MAX_ITERS"); do
  line="$(awk -F $'\t' '$1=="todo" {print; exit}' "$QUEUE" || true)"
  if [[ -z "$line" ]]; then
    echo "No remaining TODO items in $QUEUE"
    exit 0
  fi

  IFS=$'\t' read -r status task_id files rules last_commit note <<< "$line"
  IFS=',' read -ra file_list <<< "$files"
  lint_targets="${file_list[*]}"

  prompt_path="${PROMPT_DIR}/${task_id}.md"
  {
    echo "You are in the repo at $(pwd)."
    echo
    echo "Fix ESLint warnings for the following file(s) only:"
    for f in "${file_list[@]}"; do
      echo "- $f"
    done
    echo
    echo "Target rules: ${rules}"
    echo
    echo "Constraints:"
    echo "- Only edit the files listed above."
    echo "- Do not change behavior."
    echo "- Do not commit."
    echo
    echo "Goal: remove the lint warnings for these files."
    echo "No need to run lint; the loop is running in fast mode."
  } > "$prompt_path"

  echo "Starting Codex for ${task_id} (${files})"
  if ! eval "$CODEX_CMD" < "$prompt_path"; then
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
