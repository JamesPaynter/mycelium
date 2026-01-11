# MVP Scope

This repository is intentionally an MVP: it runs the orchestrator end-to-end, but several advanced behaviors from the broader spec are deferred. Use this doc to understand what is present today versus what is planned later.

## Isolation model

- Each task uses its own full clone at `~/.task-orchestrator/workspaces/<project>/run-<run-id>/task-<task-id>`.
- Containers mount only their task workspace plus a dedicated Codex home and logs directory; no task shares a working tree.
- Task manifests are copied into each workspace before execution so the worker sees the same task data as the orchestrator.

## Resume semantics (Level 1)

- Run state is persisted after each batch. On `resume`, any tasks that were `running` are reset to `pending`; completed tasks stay complete; pending tasks stay pending.
- Containers are not reattached and there is no checkpointing; a reset task reruns from the start of its manifest.
- Higher-level resume behaviors (checkpointing or container reattachment) are out of scope for this MVP.

## Validators and access declarations

- Config fields for `test_validator` and `doctor_validator` exist but are not wired into the run loop; batches do not block on LLM validators.
- The integration doctor shell command still runs after merges; validator agents are a future enhancement to gate or annotate results.
- `locks.reads` / `locks.writes` inform scheduling only. Workers run with full filesystem access; access mismatch logging is informational when present and not enforced.

## Non-goals in this release

- True reattachment to running containers or Codex threads.
- Filesystem sandboxing beyond Docker isolation.
- Validator agents that block merges or reruns.
