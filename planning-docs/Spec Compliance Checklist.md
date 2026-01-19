## Spec Compliance Checklist (2026-01-19)

### Snapshot
| Area | Status | Notes |
| --- | --- | --- |
| Planner | ✅ LLM planner emits manifest/spec JSON to `.mycelium/tasks` with per-task locks/files. | Structured output via configured provider; planner logs to JSONL. |
| Execution & resume | ✅ Stateful run/resume with per-task clones; best-effort container reattach; resets missing containers to pending. | State under `.mycelium/state`; workspaces under `~/.mycelium/workspaces/<project>/run-<id>/task-<task>`. |
| Manifest enforcement | ✅ warn/block policies, compliance reports, `access.requested` events, auto-rescope + requeue when possible. | Block mode marks tasks failed or for human review when rescope fails. |
| Validators | ✅ Test + doctor validators with `mode: warn|block`; cadence + canary triggers for doctor validator; human-review queue in block mode. | Reports live under `.mycelium/logs/<project>/run-<id>/validators/`. |
| Budgets | ✅ Token/cost budgets (`warn|block`) fed by Codex usage logs. | Emits `budget.warn`/`budget.block` events. |
| Logging | ✅ JSONL orchestrator/task logs; optional SQLite index (`logs --use-index`); `timeline`/`failures`/`doctor`/`summarize` helpers. | Index falls back to files when missing. |
| Autopilot & planning | ✅ `autopilot` interviews, drafts planning artifacts, runs planner, and kicks off runs with transcript storage. | Artifacts under `.mycelium/planning/**/*`; transcripts in `.mycelium/planning/sessions/`. |
| Strict TDD & doctors | ✅ Stage A (tests-only) + Stage B implementation when `tdd_mode: "strict"` and `verify.fast` set; integration doctor + canary per batch. | Non-test edits in Stage A fail; canary feeds doctor validator when it passes unexpectedly. |

### Implemented checks
- [x] CLI commands: `autopilot`, `plan`, `run`, `resume`, `status`, `logs`, `clean` wired and documented.
- [x] Planner provider/model configurable; tasks_dir/planning_dir resolved from repo config; resources drive scheduler locks.
- [x] Worker uses Codex `runStreamed` with checkpoint commits and worker-state persistence (thread ids, checkpoints).
- [x] Batch scheduling honors `locks.reads/writes` (read+read parallel; any write serializes conflicts) and `max_parallel`.
- [x] Per-task doctor runs each attempt; integration doctor runs after merges; canary reruns doctor with `ORCH_CANARY=1`.
- [x] Manifest compliance produces per-task reports, logs violations, and attempts auto-rescope; block mode stops merges when violations remain.
- [x] Validator reports captured and referenced in run state; block mode sets `needs_human_review`.
- [x] Resume updates state on load, reattaches containers when found, syncs worker-state checkpoints/thread ids, and resets missing containers to pending.
- [x] Token/cost accounting stored per task; budgets re-evaluated after each batch and can halt runs in block mode.
- [x] Logs: orchestrator + task JSONL, doctor logs per attempt, validator logs/reports, optional SQLite index, `logs summarize --task` with optional LLM summaries.

### Future / not yet
- [ ] Hard runtime sandboxing inside workers (current enforcement is post-task via manifest compliance).
- [ ] Seamless in-task checkpoint replay beyond git commits; deterministic resume from mid-task Codex state.
- [ ] Remote git push + branch protection enforcement; multi-host/distributed execution.
- [ ] Web/UI visualization beyond CLI + JSONL/SQLite.
