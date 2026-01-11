## Spec Corrections & Clarifications

### 1. Workspace Isolation (Critical Fix)

**Original spec said:** Mount repo into container, checkout branch

**Problem:** Multiple containers sharing same git working tree = race conditions

**Corrected approach:**

Each task gets its own **cloned workspace**:

```
~/.task-orchestrator/workspaces/
└── <project>/
    └── run-<run-id>/
        ├── task-001/    # Full clone, checked out to agent/001-*
        ├── task-002/    # Full clone, checked out to agent/002-*
        └── task-003/    # Full clone, checked out to agent/003-*
```

Container mounts its own workspace:
```typescript
HostConfig: {
  Binds: [
    `${workspacePath}/task-${taskId}:/workspace:rw`,
  ],
}
```

After task completes, orchestrator:
1. Fetches from task workspace into main repo
2. Merges task branch into integration branch
3. Optionally cleans up workspace

---

### 2. Codex Config (Corrected)

**Original spec used outdated TOML structure**

**Corrected config.toml:**

```toml
model = "gpt-5.1-codex-max"
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

---

### 3. Access Requests (Clarified)

**Original spec implied:** Permission denied triggers access.requested

**Reality:** With full filesystem access in container, there's no denial mechanism

**Corrected approach:**

Access requests are **informational, not enforced**:

1. Manifest declares expected reads/writes
2. Worker can access anything (Docker provides isolation, not file-level sandboxing)
3. If worker touches files not in manifest, it logs `access.undeclared` event
4. This is for **scheduling correctness feedback**, not runtime enforcement
5. If undeclared access caused a parallel conflict, next run's manifest should be updated

```jsonl
{"type":"access.undeclared","task_id":"002","file":"shared/validation.py","access_type":"read","note":"Not in manifest, may affect future scheduling"}
```

**Future enhancement:** True enforcement via filesystem overlay or Codex sandbox configuration

---

### 4. Resume Strategy (Clarified)

**Original spec implied:** Seamless reattachment to running containers

**Reality:** That's complex and not MVP

**Clarified levels of resume:**

**Level 1 (MVP - Implemented):**
- State persisted after each task completion
- On crash: completed tasks skipped, running tasks reset to pending, pending unchanged
- "Restartable" — work restarts from last completed task, not from exact point of failure

**Level 2 (Future):**
- Periodic commits within task (checkpointing)
- On crash: task restarts from last checkpoint commit
- Less wasted work, still not seamless

**Level 3 (Future):**
- Container discovery and reattachment
- Codex thread resumption via `resumeThread(threadId)`
- True seamless resume

**Spec should state:** MVP implements Level 1. Levels 2-3 are future enhancements.

---

### 5. Bootstrap Lifecycle (Added)

**Original spec missing:** How containers install dependencies before doctor

**Added to project config:**

```yaml
# Commands run before worker starts, in order
bootstrap:
  - "npm install"
  - "pip install -r requirements.txt"
  - "make setup"

# Or for complex cases, custom Dockerfile
docker:
  dockerfile: ./Dockerfile.worker  # Project-specific image
```

**Worker lifecycle becomes:**

```
1. Clone workspace
2. Checkout branch
3. Run bootstrap commands
4. Start Codex worker
5. Execute task
6. Run doctor
7. Commit on success
```

---

### 6. Validators (Clarified Scope)

**Original spec described:** LLM-based test and doctor validation

**Clarified:** These are future enhancements, not MVP

**MVP behavior:**
- Tasks merge if doctor passes
- No LLM validation gate

**Future enhancement spec:**

Test Validator requires:
- Input: git diff of changed test files + tested code
- Stability: deterministic prompt, temperature 0
- Output schema: `{ pass: boolean, concerns: [...], confidence: number }`
- Gating policy: 
  - `pass=true` → auto-merge
  - `pass=false, confidence>0.8` → block merge, flag for human
  - `pass=false, confidence<0.8` → warn but allow merge

Doctor Validator requires:
- Input: doctor command + recent outputs + recent changes
- Trigger: every N tasks, or on suspicious patterns
- Output: effectiveness assessment
- Action: warning to human, not blocking

---

### 7. Branch Permissions (Clarified)

**Original spec implied:** Container can only push to its branch

**Reality:** Not enforceable in local-only mode

**Clarified approach:**

**Local mode (MVP):**
- Workers never push
- Workers commit to local clone
- Orchestrator fetches from clone and merges
- No branch permission enforcement (trust the isolation)

**Remote mode (future):**
- Workers push to remote
- Branch protection rules on remote enforce permissions
- Or: orchestrator holds credentials, workers request push via API

---

### 8. Log Query (Clarified Scope)

**Original spec described:** Rich querying, LLM summarization

**Clarified:** MVP is minimal

**MVP:**
- `logs` command prints raw JSONL
- `logs --task <id>` prints task events
- `logs --search <pattern>` does grep-style filtering

**Future enhancement:**
- Indexed log storage (SQLite or similar)
- Structured queries
- Timeline visualization
- LLM summarization of failures

---

## Updated Spec Sections

### Section 10.2 Container Lifecycle (Corrected)

**Create workspace:**
```typescript
// Clone repo for this task
const workspacePath = `${config.workspacesDir}/${project}/${runId}/task-${taskId}`;
await exec(`git clone ${repoPath} ${workspacePath}`);
await exec(`git checkout -b ${branch}`, { cwd: workspacePath });
```

**Create container:**
```typescript
const container = await docker.createContainer({
  Image: projectConfig.dockerImage,
  name: `task-${taskId}-${runId}`,
  Env: [
    `CODEX_API_KEY=${secrets.codexApiKey}`,
    `TASK_ID=${taskId}`,
    `DOCTOR_CMD=${projectConfig.doctor}`,
    `MAX_RETRIES=${projectConfig.maxRetries}`,
  ],
  HostConfig: {
    Binds: [
      `${workspacePath}:/workspace:rw`,
    ],
  },
  WorkingDir: '/workspace',
});
```

**Run bootstrap:**
```typescript
for (const cmd of projectConfig.bootstrap) {
  await container.exec({ Cmd: ['sh', '-c', cmd] });
}
```

**After task completes:**
```typescript
// Fetch task branch from workspace into main repo
await exec(`git fetch ${workspacePath} ${branch}:${branch}`, { cwd: repoPath });
```

---

### Section 5.4 (New) Bootstrap Configuration

```yaml
# Project config

# Bootstrap commands run in container before worker starts
bootstrap:
  - "npm install"
  - "pip install -r requirements.txt"

# Or specify custom Dockerfile for complex environments
docker:
  image: task-orchestrator-worker:latest      # Default
  # dockerfile: ./custom/Dockerfile.worker    # Override with project-specific
```

---

### Section 13.4 Orchestrator Crash (Corrected)

```
Orchestrator process dies
        │
        ▼
On restart: load state file
        │
        ▼
For each task:
        │
        ├── status: complete ──► Skip
        │
        ├── status: running ──► Reset to pending
        │       │                (MVP: restart from scratch)
        │       │
        │       └── Future: reattach or resume from checkpoint
        │
        └── status: pending ──► Schedule when ready
```

---

### Section 19. Future Enhancements (Updated)

1. **Claude Agent SDK support** — Alternative worker engine

2. **Enforced file access policy** — True sandboxing so access.requested is enforced, not informational

3. **Seamless resume (Level 2-3)** — Checkpointing, container reattachment, thread resumption

4. **Test Validator** — LLM-based test quality gate with confidence scoring

5. **Doctor Validator** — LLM-based doctor effectiveness assessment

6. **Indexed log storage** — SQLite backend for structured queries

7. **Remote branch protection** — Credentials management, push permissions

8. **Distributed execution** — Workers on remote machines

9. **Web UI** — Dashboard for monitoring

10. **Cost tracking** — Token usage per task/run

---

## Summary of Changes

| Area | Original | Corrected |
|------|----------|-----------|
| Workspace | Shared mount, checkout branch | Separate clone per task |
| Codex config | Outdated TOML structure | Current flat keys |
| Access requests | Enforced via permission denied | Informational only (MVP) |
| Resume | Implied seamless | Explicit levels, MVP is restart |
| Bootstrap | Missing | Added to config |
| Validators | Implied MVP | Clarified as future |
| Branch permissions | Implied enforced | Clarified as trust-based (MVP) |
| Log query | Implied rich | Clarified as minimal (MVP) |
