## Spec Corrections & Clarifications

### 1. Workspace Isolation (Implemented)
- **Original:** Mount shared repo into each container.
- **Now:** Each task gets its own clone under `~/.mycelium/workspaces/<project>/run-<id>/task-<task>` and mounts that path. Merges fetch from the workspace into the integration branch.

### 2. Codex Config (Corrected)
- **Original:** Outdated TOML.
- **Now:** Flat TOML written to `CODEX_HOME`:
  ```toml
  model = "gpt-5.2-codex"
  model_reasoning_effort = "xhigh"
  approval_policy = "never"
  sandbox_mode = "danger-full-access"
  ```

### 3. Access Requests + Manifest Enforcement (Implemented)
- Containers have full filesystem access; enforcement happens **after** task completion.
- Orchestrator runs manifest compliance (diff vs integration) and logs `manifest.compliance.*` + `access.requested` for undeclared writes.
- Policy drives behavior:
  - `off` → skip compliance
  - `warn` → log violations
  - `block` → log + block merge
- Auto-rescope tries to add missing locks/files to the manifest and resets the task to `pending` for another run. Failures mark the task for human review.

### 4. Resume Strategy (Implemented Level 1 + best-effort reattach)
- State saved after every state mutation.
- `resume` reloads state, reattaches to labeled containers when they still exist (streams historical logs), and syncs worker checkpoints/thread ids from `.mycelium/worker-state.json`.
- Missing/exited containers are reset to `pending`. No mid-task checkpoints beyond git commits. Container discovery is best-effort; seamless resume remains future work.

### 5. Bootstrap Lifecycle (Implemented)
- `bootstrap: [...]` runs inside each worker before Codex starts; use it for `npm ci`, `pip install`, etc.
- Docker config supports custom Dockerfile/build context and runtime limits (user, network mode, memory/CPU/PIDs).

### 6. Validators (Implemented)
- Test and doctor validators run after successful tasks. Config: `enabled` + `mode: warn|block` + provider/model.
- Doctor validator triggers on cadence (`run_every_n_tasks`) **and** when integration doctor fails or the canary passes unexpectedly.
- Block mode gates merges and marks `needs_human_review`; warn mode records advisory reports.

### 7. Branch Permissions (Clarified)
- Local-only MVP: workers commit locally; orchestrator merges into the integration branch. No remote push/branch protection enforcement yet. Remote-mode remains future.

### 8. Log Query (Implemented with index)
- `logs` streams JSONL, with `logs --use-index` building/querying a SQLite index (timeline/failures/search) and falling back to files if unavailable.
- Optional LLM summaries for validator failures when `log_summaries.enabled` is true.

### 9. Autopilot + Planning (Implemented)
- `autopilot` interviews the operator (configurable question cap), drafts planning artifacts under `.mycelium/planning/`, runs the planner, then starts `run` (or stops after planning with `--skip-run`). Transcripts live in `.mycelium/planning/sessions/`.
- Planner outputs manifest/spec pairs to `.mycelium/tasks` (or override) and records planner logs to JSONL.

### 10. Strict TDD + Canary Doctors (Implemented)
- When `tdd_mode: "strict"` and `verify.fast` is present, workers enforce Stage A (tests only, must fail) then Stage B (implementation) with checkpoint commits between doctor attempts.
- Integration doctor runs after each batch; a canary reruns doctor with `ORCH_CANARY=1` and feeds the doctor validator when it unexpectedly passes.

---

## Updated Summary (Jan 2026)

| Area | Implemented now | Future / Notes |
|------|-----------------|----------------|
| Workspace isolation | Per-task clones + labeled containers | — |
| Manifest enforcement | warn/block + auto-rescope + `access.requested` | Live FS sandboxing |
| Resume | Stateful resume + container reattach + worker thread/checkpoint sync | Seamless in-task checkpoint replay |
| Validators | Test + doctor validators with warn/block gating, cadence + canary triggers | Additional validator types |
| Budgets | Token/cost budgets with warn/block modes | More granular pricing sources |
| Log tooling | JSONL + SQLite index, timeline/failures search | Rich UI/visualization |
| Autopilot | Interview → artifacts → plan → run/resume | Multi-run supervision, UI |
| Strict TDD | Stage A/B flow with fast doctor expectation | — |
| Branch permissions | Local merges only | Remote push + branch protection |
