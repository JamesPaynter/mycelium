#!/usr/bin/env python3
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 6:
        print("Usage: lint-queue-update.py <queue> <id> <status> <commit> <note>", file=sys.stderr)
        return 2

    queue_path = Path(sys.argv[1])
    task_id = sys.argv[2]
    status = sys.argv[3]
    commit = sys.argv[4]
    note = sys.argv[5]

    lines = queue_path.read_text(encoding="utf-8").splitlines()
    updated = []
    found = False

    for line in lines:
        if line.startswith("#") or not line.strip():
            updated.append(line)
            continue
        parts = line.split("\t")
        if len(parts) < 6:
            parts += [""] * (6 - len(parts))
        if parts[1] == task_id:
            parts[0] = status
            parts[4] = commit
            parts[5] = note
            found = True
        updated.append("\t".join(parts[:6]))

    if not found:
        print(f"Task id not found: {task_id}", file=sys.stderr)
        return 1

    queue_path.write_text("\n".join(updated) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
