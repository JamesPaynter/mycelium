#!/usr/bin/env bash
set -euo pipefail

QUEUE="${QUEUE:-scripts/lint-queue.tsv}"

if [[ ! -f "$QUEUE" ]]; then
  echo "Queue not found: $QUEUE" >&2
  exit 1
fi

awk -F $'\t' 'BEGIN{OFS="\t"} $1=="todo" {print; exit}' "$QUEUE"
