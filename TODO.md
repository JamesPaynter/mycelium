# TODO

- [x] [049 - Docs parity and spec rebaseline](docs/tasks/archive/049-docs-parity-and-spec-rebaseline/spec.md) (Effort <M>, Tier <standard>)
- [x] [050 - Docker-mode end-to-end smoke test](docs/tasks/archive/050-docker-mode-e2e-smoke-test/spec.md) (Effort <L>, Tier <standard>)
- [x] [051 - Resume and crash recovery acceptance suite (reattach + thread resume)](docs/tasks/archive/051-resume-and-crash-recovery-acceptance-suite/spec.md) (Effort <L>, Tier <pro>)
- [x] [052 - Graceful stop semantics (SIGINT/SIGTERM) and reliable resume](docs/tasks/archive/052-signal-handling-and-clean-stop/spec.md) (Effort <M>, Tier <standard>)
- [x] [053 - Template & packaging cleanup (reduce ambiguity)](docs/tasks/archive/053-template-and-packaging-cleanup/spec.md) (Effort <M>, Tier <standard>)
- [x] [054 - Spec traceability matrix and acceptance checklist](docs/tasks/archive/054-spec-traceability-matrix-and-acceptance-checklist/spec.md) (Effort <M>, Tier <standard>)

## Control Plane — Phase A (agent navigation tools)

- [ ] [055 - Control Plane navigation CLI skeleton](.mycelium/tasks/055-control-plane-navigation-cli-skeleton/spec.md) (Effort <M>, Tier <standard>)
- [x] [056 - Commit-addressed model store + cp build/info](.mycelium/tasks/056-commit-addressed-model-store-cp-build-info/spec.md) (Effort <M>, Tier <standard>)
- [ ] [057 - Component boundaries + file ownership queries](.mycelium/tasks/057-component-boundaries-file-ownership-queries/spec.md) (Effort <L>, Tier <standard>)
- [ ] [058 - Component dependency edges + deps/rdeps queries](.mycelium/tasks/058-component-dependency-edges-deps-rdeps-queries/spec.md) (Effort <L>, Tier <pro>)
- [ ] [059 - Blast radius query](.mycelium/tasks/059-blast-radius-query/spec.md) (Effort <M>, Tier <standard>)
- [ ] [060 - TypeScript symbol index (definitions)](.mycelium/tasks/060-typescript-symbol-index-definitions/spec.md) (Effort <L>, Tier <pro>)
- [x] [061 - TypeScript symbol references](.mycelium/tasks/061-typescript-symbol-references/spec.md) (Effort <L>, Tier <pro>)
- [ ] [062 - Make navigation tools agent-native](.mycelium/tasks/062-make-navigation-tools-agent-native/spec.md) (Effort <M>, Tier <standard>)
- [ ] [063 - Fixture repo + golden tests](.mycelium/tasks/063-fixture-repo-golden-tests/spec.md) (Effort <M>, Tier <standard>)
- [ ] [064 - Docker-mode smoke test for Control Plane tools](.mycelium/tasks/064-docker-mode-smoke-test-for-control-plane-tools/spec.md) (Effort <M>, Tier <standard>)

## Control Plane — Phase B (graph-derived scope, locks, and safety policy)

- [ ] [065 - Pin Control Plane model to a run (base SHA handshake)](.mycelium/tasks/065-pin-control-plane-model-to-a-run-base-sha-handshake/spec.md) (Effort <M>, Tier <standard>)
- [ ] [066 - Graph-derived resources (components) merged into scheduling + manifest enforcement](.mycelium/tasks/066-graph-derived-resources-components-merged-into-scheduling-manifest-enforcement/spec.md) (Effort <L>, Tier <pro>)
- [ ] [067 - Derived scope engine (shadow reports)](.mycelium/tasks/067-derived-scope-engine-shadow-reports/spec.md) (Effort <M>, Tier <standard>)
- [ ] [068 - Scheduler lock mode: declared vs shadow vs derived (opt-in)](.mycelium/tasks/068-scheduler-lock-mode-declared-vs-shadow-vs-derived-opt-in/spec.md) (Effort <M>, Tier <standard>)
- [ ] [069 - Graph-backed scope compliance: warn → block rollout](.mycelium/tasks/069-graph-backed-scope-compliance-warn-block-rollout/spec.md) (Effort <M>, Tier <standard>)
- [ ] [070 - Blast radius from diff: touched → impacted components](.mycelium/tasks/070-blast-radius-from-diff-touched-impacted-components/spec.md) (Effort <M>, Tier <standard>)
- [ ] [071 - Scoped checkset computation (conservative fallback to doctor)](.mycelium/tasks/071-scoped-checkset-computation-conservative-fallback-to-doctor/spec.md) (Effort <L>, Tier <pro>)
- [ ] [072 - Surface change detection MVP (contracts/config/public entrypoints)](.mycelium/tasks/072-surface-change-detection-mvp-contracts-config-public-entrypoints/spec.md) (Effort <S>, Tier <standard>)
- [ ] [073 - Surface-aware gates + optional surface locks](.mycelium/tasks/073-surface-aware-gates-optional-surface-locks/spec.md) (Effort <M>, Tier <standard>)
- [ ] [074 - Autonomy tiers (risk classification that drives enforcement)](.mycelium/tasks/074-autonomy-tiers-risk-classification-that-drives-enforcement/spec.md) (Effort <M>, Tier <standard>)
- [ ] [075 - Policy transparency: cp policy eval + per-task artifacts](.mycelium/tasks/075-policy-transparency-cp-policy-eval-per-task-artifacts/spec.md) (Effort <S>, Tier <standard>)
- [ ] [076 - Metrics + feedback loop for Phase B (prove value, guide simplification)](.mycelium/tasks/076-metrics-feedback-loop-for-phase-b-prove-value-guide-simplification/spec.md) (Effort <S>, Tier <standard>)

- [ ] ALL_TASKS_COMPLETE

## Mycelium Visualizer UI (read-only localhost)

### Phase UI-0: Server + APIs (cursor-based tail)
- [ ] [077 - UI server scaffolding + static hosting + run summary endpoint](.mycelium/tasks/077-ui-server-scaffold-summary-endpoint/spec.md)
- [ ] [078 - JSONL cursor/offset tail helper (shared, tested)](.mycelium/tasks/078-jsonl-tail-cursor-helper/spec.md)
- [ ] [079 - Orchestrator events API: /orchestrator/events (cursor + typeGlob)](.mycelium/tasks/079-api-orchestrator-events-tail/spec.md)
- [ ] [080 - Task events API: /tasks/:taskId/events (cursor + typeGlob); bootstrap output via typeGlob=bootstrap.*](.mycelium/tasks/080-api-task-events-tail-bootstrap-filter/spec.md)
- [ ] [081 - Diagnostics APIs: doctor snippet, compliance.json, validator reports](.mycelium/tasks/081-api-diagnostics-doctor-compliance-validators/spec.md)

### Phase UI-1: CLI + Config integration
- [ ] [082 - Config schema + CLI wiring (mycelium ui; run/resume start UI by default with --no-ui)](.mycelium/tasks/082-cli-config-ui-integration/spec.md)

### Phase UI-2: Frontend MVP
- [ ] [083 - Static frontend MVP (overview, tasks list, task detail w/ event tail + filters)](.mycelium/tasks/083-frontend-mvp-static-ui/spec.md)

### Phase UI-3: Build + Tests
- [ ] [084 - Build/packaging (dist/ui) + unit/smoke tests (cursor tail + endpoints)](.mycelium/tasks/084-build-packaging-tests-ui/spec.md)

- [ ] ALL_TASKS_COMPLETE
