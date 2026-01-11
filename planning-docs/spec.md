## Task Orchestrator — Complete System Specification

---

# 1. Purpose

A standalone, reusable system for autonomous code execution. It takes any software project, facilitates structured planning, converts plans into executable tickets, and runs them in parallel using LLM-powered workers in isolated Docker containers.

Designed to run unattended for 12-24 hours with crash recovery, structured logging, safe parallelization, and validation at every step.

---

# 2. Design Principles

1. **Complete isolation** — Each task runs in its own Docker container on its own git branch. No shared state between workers. No possibility of interference.

2. **Total resumability** — All state persists to disk. Process crashes, machine restarts, network failures — the system recovers from where it stopped.

3. **Safe parallelism** — Tasks declare resource locks. Only tasks with no conflicts run in parallel. The system enforces this mechanically, not by trust.

4. **Structured everything** — Tickets are JSON. Logs are JSONL. State is JSON. Planning artifacts are markdown with defined structure. Nothing is unstructured text that requires parsing.

5. **Project-agnostic** — The orchestrator knows nothing about specific codebases. All project-specific configuration lives in yaml files. The same tool works for any repository.

6. **Observable** — Every action is logged. Every decision is traceable. Failures are queryable. The system can explain what happened and why.

7. **Validated** — Tests are validated for correctness. Doctor commands are validated for effectiveness. The system doesn't trust — it verifies.

8. **Nothing is lost** — Planning sessions are preserved. Architecture decisions are documented. Implementation rationale is captured. The full history of how and why is always available.

---

# 3. System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                              HUMAN + BOT                                    │
│                           (Interactive Sessions)                            │
│                                                                             │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│   │   PHASE 0   │────▶│   PHASE 1   │────▶│   PHASE 2   │                   │
│   │  Discovery  │     │Architecture │     │   Impl Plan │                   │
│   └─────────────┘     └─────────────┘     └─────────────┘                   │
│         │                   │                   │                           │
│         ▼                   ▼                   ▼                           │
│   requirements.md     architecture.md    implementation-plan.md             │
│   research-notes.md   decisions.md       risk-assessment.md                 │
│   api-findings.md     infrastructure.md                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                               PLANNER                                       │
│                          (Automated, LLM)                                   │
│                                                                             │
│   Input:  implementation-plan.md + codebase (read-only)                     │
│   Output: Structured JSON tickets                                           │
│           Orchestrator writes manifest.json + spec.md per ticket            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                             ORCHESTRATOR                                    │
│                           (Automated, Code)                                 │
│                                                                             │
│   1. Load manifests                                                         │
│   2. Build parallel batches from resource locks                             │
│   3. Spawn Docker containers per task                                       │
│   4. Monitor workers, stream logs                                           │
│   5. Run validators on completion                                           │
│   6. Merge successful branches                                              │
│   7. Persist state continuously                                             │
│   8. Repeat until all tasks complete                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│   DOCKER CONTAINER    │ │   DOCKER CONTAINER    │ │   DOCKER CONTAINER    │
│                       │ │                       │ │                       │
│   Branch: agent/001   │ │   Branch: agent/002   │ │   Branch: agent/003   │
│                       │ │                       │ │                       │
│   ┌───────────────┐   │ │   ┌───────────────┐   │ │   ┌───────────────┐   │
│   │    WORKER     │   │ │   │    WORKER     │   │ │   │    WORKER     │   │
│   │    (Codex)    │   │ │   │    (Codex)    │   │ │   │    (Codex)    │   │
│   │               │   │ │   │               │   │ │   │               │   │
│   │  Execute      │   │ │   │  Execute      │   │ │   │  Execute      │   │
│   │     ↓         │   │ │   │     ↓         │   │ │   │     ↓         │   │
│   │  Doctor       │   │ │   │  Doctor       │   │ │   │  Doctor       │   │
│   │     ↓         │   │ │   │     ↓         │   │ │   │     ↓         │   │
│   │  Pass/Retry   │   │ │   │  Pass/Retry   │   │ │   │  Pass/Retry   │   │
│   └───────────────┘   │ │   └───────────────┘   │ │   └───────────────┘   │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘
                │                   │                   │
                └───────────────────┼───────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                              VALIDATORS                                     │
│                           (Automated, LLM)                                  │
│                                                                             │
│   ┌─────────────────────┐         ┌─────────────────────┐                   │
│   │   TEST VALIDATOR    │         │  DOCTOR VALIDATOR   │                   │
│   │                     │         │                     │                   │
│   │  Are changed tests  │         │  Is doctor actually │                   │
│   │  actually valid?    │         │  catching failures? │                   │
│   │  Not tautological?  │         │  Working as needed? │                   │
│   └─────────────────────┘         └─────────────────────┘                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                            MERGE & INTEGRATE                                │
│                                                                             │
│   1. Merge task branches into development-codex                             │
│   2. Run integration doctor                                                 │
│   3. Continue to next batch                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# 4. Components

## 4.1 Orchestrator

**Type:** Node/TypeScript process

**Role:** Central coordinator. Manages the entire execution lifecycle.

**Responsibilities:**
- Load project configuration
- Load task manifests
- Build parallel batches from resource lock analysis
- Create git branches for each task
- Spawn and monitor Docker containers
- Stream logs from workers
- Invoke validators
- Manage git merges
- Persist state for crash recovery
- Handle failures and retries
- Query logs on failure for debugging context

**Not an LLM.** Pure deterministic code.

---

## 4.2 Planner

**Type:** LLM agent

**Role:** Convert implementation plan into structured, executable tickets.

**Input:**
- Implementation plan (markdown, from human+bot planning session)
- Codebase access (read-only)
- Project resource definitions

**Output:**
- Structured JSON conforming to ticket schema
- Orchestrator writes this to manifest.json + spec.md files

**Execution mode:** Read-only. Cannot write files directly. Returns JSON via structured output. Orchestrator writes the files.

**Provider:** OpenAI or Anthropic (configurable per project)

**Model:** Configurable (e.g., `o3`, `claude-opus-4-5-20250514`)

---

## 4.3 Worker

**Type:** Codex agent in Docker container

**Role:** Execute a single ticket autonomously.

**Input:**
- spec.md containing full task description
- manifest.json containing metadata
- Git branch checked out and ready

**Execution:**
- Runs Codex with full permissions (safe because container is isolated)
- Uses Codex SDK `runStreamed()` for structured event streaming
- Executes work according to spec
- Runs doctor command to verify
- If doctor fails, feeds error back to Codex and retries
- If discovers need for undeclared file access, logs it and continues
- On doctor pass, commits and exits
- On max retries exceeded, exits with failure

**Provider:** OpenAI (Codex SDK)

**Model:** Configurable (e.g., `gpt-5.1-codex-max`)

**Max retries:** Configurable per project, default 20

---

## 4.4 Test Validator

**Type:** LLM agent

**Role:** Validate that changed/added tests are legitimate.

**When:** After task completion, before merge

**What it checks:**
- Tests actually test something real
- Assertions are not tautological (always pass)
- Tests are not mocked to uselessness
- Tests would fail if the feature broke
- Test coverage is meaningful

**Input:**
- Diff of changed test files
- The code being tested
- Task spec for context

**Output:**
- Pass/fail
- If fail: specific concerns, which tests are suspect

**On failure:** Task flagged for human review, not auto-merged

---

## 4.5 Doctor Validator

**Type:** LLM agent

**Role:** Validate that the doctor command is actually working.

**When:** 
- Periodically during long runs
- After suspicious patterns (doctor passes but integration fails)
- On human request

**What it checks:**
- Doctor command would catch real failures
- Doctor is not passing vacuously
- Doctor covers the areas being changed

**Input:**
- Doctor command
- Recent doctor outputs
- Recent changes

**Output:**
- Assessment of doctor effectiveness
- Recommendations if doctor seems insufficient

---

## 4.6 Log Query System

**Type:** Code + optional LLM for summarization

**Role:** Make logs searchable and queryable, especially on failures.

**Capabilities:**
- Find all events for a specific task
- Find all failures in a run
- Find all doctor outputs
- Search for specific error patterns
- Summarize what happened in a failed task (LLM)
- Correlate events across tasks

**Interface:** CLI commands and programmatic API

---

# 5. Planning Phase (Human + Bot)

## 5.1 Overview

Before automated execution, humans work interactively with an LLM to plan the work. This is not automated. This is collaborative thinking.

The planning phases produce structured artifacts that are preserved permanently.

## 5.2 Phase 0: Discovery

**Purpose:** Understand what we're building and what's possible.

**Activities:**
- Define requirements
- Research current state of relevant APIs, SDKs, tools
- Explore technical possibilities
- Identify constraints

**Artifacts produced:**
```
docs/planning/000-discovery/
├── requirements.md        # What we need to build
├── research-notes.md      # Findings from research
└── api-findings.md        # Relevant API docs, SDK versions, capabilities
```

**Tools available:** Web search, URL fetching, documentation retrieval

## 5.3 Phase 1: Architecture

**Purpose:** Design the system structure.

**Activities:**
- Define components and boundaries
- Design data flow
- Make technology choices
- Consider infrastructure requirements
- Iterate between architecture and constraints

**Artifacts produced:**
```
docs/planning/001-architecture/
├── architecture.md        # System design
├── decisions.md           # Key decisions and rationale
└── infrastructure.md      # Infrastructure requirements
```

## 5.4 Phase 2: Implementation Plan

**Purpose:** Break architecture into buildable chunks.

**Activities:**
- Decompose into tasks
- Identify dependencies and ordering
- Assess risks
- Estimate effort

**Artifacts produced:**
```
docs/planning/002-implementation/
├── implementation-plan.md  # The plan that feeds into Planner
└── risk-assessment.md      # Known risks and mitigations
```

## 5.5 Session Preservation

Every planning session is preserved:

```
docs/planning/sessions/
├── 2025-01-11-discovery.md           # Transcript or summary
├── 2025-01-11-architecture.md
├── 2025-01-12-architecture-rev.md    # Revision session
└── 2025-01-12-implementation.md
```

Nothing is lost. The full history of how decisions were made is always available.

---

# 6. Resource Lock System

## 6.1 Purpose

Enable safe parallelism by declaring what each task touches. The scheduler uses this to determine which tasks can run simultaneously.

## 6.2 Why Resources, Not Files

File paths are too granular and error-prone. A task might:
- Import from a file without listing it
- Depend on generated files
- Use shared utilities implicitly

Resources are abstract buckets representing major code boundaries. They're defined once per project and are easier to reason about correctly.

## 6.3 Defining Resources

Each project defines 5-15 resources in its config:

```yaml
resources:
  - name: shared-types
    description: Shared type definitions and schemas
    paths:
      - shared/schemas/*
      - shared/models/*
      - shared/types/*
  
  - name: api-public
    description: Public API surface
    paths:
      - backend-public/*
  
  - name: api-private
    description: Private/internal API
    paths:
      - backend-private/*
  
  - name: frontend
    description: Frontend application
    paths:
      - frontend/*
  
  - name: data-pipeline
    description: ETL and data processing
    paths:
      - etl/*
      - workers/*
  
  - name: build-system
    description: Build configuration and dependencies
    paths:
      - package.json
      - requirements*.txt
      - Makefile
      - Dockerfile*
      - "*.config.js"
```

## 6.4 Lock Declarations

Each task declares which resources it reads and writes:

```json
{
  "locks": {
    "reads": ["shared-types"],
    "writes": ["api-public"]
  }
}
```

## 6.5 Scheduling Rules

| Task A | Task B | Can run in parallel? |
|--------|--------|---------------------|
| reads X | reads X | **Yes** — both just reading |
| reads X | writes X | **No** — B might change what A reads |
| writes X | reads X | **No** — A might change what B reads |
| writes X | writes X | **No** — conflict |

## 6.6 Batch Building Algorithm

```
function buildBatches(tasks):
    batches = []
    remaining = copy(tasks)
    
    while remaining is not empty:
        batch = []
        batchReads = set()
        batchWrites = set()
        
        for task in remaining:
            canAdd = true
            
            # Check if task writes conflict with batch
            for resource in task.locks.writes:
                if resource in batchReads or resource in batchWrites:
                    canAdd = false
                    break
            
            # Check if task reads conflict with batch writes
            if canAdd:
                for resource in task.locks.reads:
                    if resource in batchWrites:
                        canAdd = false
                        break
            
            if canAdd:
                batch.append(task)
                batchReads.addAll(task.locks.reads)
                batchWrites.addAll(task.locks.writes)
                remaining.remove(task)
        
        batches.append(batch)
    
    return batches
```

---

# 7. Data Schemas

## 7.1 Project Configuration

```yaml
# Location: ~/.task-orchestrator/projects/<project-name>.yaml

# === Repository ===
repo_path: /absolute/path/to/repo
main_branch: development-codex    # Integration branch
task_branch_prefix: agent/        # Task branches: agent/001-task-name

# === Execution Limits ===
max_parallel: 10                  # Max concurrent containers
max_retries: 20                   # Max retries per task before failure

# === Resources ===
resources:
  - name: shared-types
    description: Shared type definitions
    paths: [shared/*]
  - name: api-public
    paths: [backend-public/*]
  # ... more resources

# === Verification ===
doctor: "make test && make lint"  # Command that must pass

# === Models ===
planner:
  provider: openai                # openai | anthropic
  model: o3

worker:
  model: gpt-5.1-codex-max

test_validator:
  provider: openai
  model: o3

doctor_validator:
  provider: openai
  model: o3
```

## 7.2 Task Manifest

```json
{
  "id": "001",
  "name": "add-health-endpoint",
  "description": "Add /api/health endpoint that returns service status",
  "estimated_minutes": 15,
  
  "locks": {
    "reads": ["shared-types"],
    "writes": ["api-public"]
  },
  
  "files": {
    "reads": [
      "shared/schemas.py",
      "shared/http.py"
    ],
    "writes": [
      "backend-public/app/routes/health.py",
      "backend-public/app/main.py"
    ]
  },
  
  "affected_tests": [
    "backend-public/tests/test_health.py"
  ],
  
  "verify": {
    "doctor": "make test && make lint",
    "fast": "pytest backend-public/tests/test_health.py -x"
  }
}
```

## 7.3 Task Spec

```markdown
# 001 — Add Health Endpoint

## Summary

Add /api/health endpoint to backend-public that returns service status.

## Requirements

- Endpoint: GET /api/health
- Response: 200 OK with JSON body
  ```json
  {
    "status": "healthy",
    "timestamp": "2025-01-11T10:00:00Z",
    "version": "1.0.0"
  }
  ```
- No authentication required
- Must pass all existing tests plus new test_health.py

## Implementation Approach

1. Create new route file: backend-public/app/routes/health.py
2. Define HealthResponse schema in file (or import from shared if exists)
3. Implement GET /api/health handler
4. Register router in backend-public/app/main.py
5. Add tests in backend-public/tests/test_health.py

## Patterns to Follow

- See backend-public/app/routes/status.py for similar endpoint pattern
- Use FastAPI router pattern consistent with existing routes
- Follow project code conventions in CLAUDE.md

## Verification

```bash
# Fast check
pytest backend-public/tests/test_health.py -x

# Full doctor
make test && make lint
```

## Notes

- Keep response schema simple
- Include version from environment or config if available
```

## 7.4 Run State

```json
{
  "run_id": "2025-01-11-001",
  "project": "faangmatch",
  "started_at": "2025-01-11T10:00:00Z",
  "updated_at": "2025-01-11T10:45:00Z",
  "status": "running",
  
  "batches": [
    {
      "batch_id": 1,
      "status": "complete",
      "tasks": ["001", "002", "004"],
      "started_at": "2025-01-11T10:00:00Z",
      "completed_at": "2025-01-11T10:30:00Z",
      "merge_commit": "abc123f"
    },
    {
      "batch_id": 2,
      "status": "running",
      "tasks": ["003", "005"],
      "started_at": "2025-01-11T10:30:00Z"
    }
  ],
  
  "tasks": {
    "001": {
      "status": "complete",
      "batch_id": 1,
      "branch": "agent/001-add-health-endpoint",
      "container_id": "abc123",
      "attempts": 1,
      "started_at": "2025-01-11T10:00:00Z",
      "completed_at": "2025-01-11T10:12:00Z",
      "tokens_used": 3421,
      "test_validation": "pass"
    },
    "002": {
      "status": "complete",
      "batch_id": 1,
      "branch": "agent/002-fix-frontend-form",
      "container_id": "def456",
      "attempts": 3,
      "started_at": "2025-01-11T10:00:00Z",
      "completed_at": "2025-01-11T10:28:00Z",
      "tokens_used": 12847,
      "test_validation": "pass",
      "access_requests": [
        {
          "file": "shared/validation.py",
          "type": "read",
          "requested_at": "2025-01-11T10:08:00Z",
          "granted": true
        }
      ]
    },
    "003": {
      "status": "running",
      "batch_id": 2,
      "branch": "agent/003-update-schema",
      "container_id": "ghi789",
      "attempts": 1,
      "started_at": "2025-01-11T10:30:00Z"
    },
    "004": {
      "status": "complete",
      "batch_id": 1,
      "branch": "agent/004-etl-fix",
      "container_id": "jkl012",
      "attempts": 1,
      "started_at": "2025-01-11T10:00:00Z",
      "completed_at": "2025-01-11T10:25:00Z",
      "tokens_used": 5210,
      "test_validation": "pass"
    },
    "005": {
      "status": "pending",
      "batch_id": 2
    }
  }
}
```

---

# 8. Logging System

## 8.1 Structure

```
logs/
└── <project>/
    └── run-<run-id>/
        ├── orchestrator.jsonl              # Orchestrator events
        ├── planner.jsonl                   # Planner events
        ├── validators/
        │   ├── test-validator.jsonl        # Test validation events
        │   └── doctor-validator.jsonl      # Doctor validation events
        └── tasks/
            ├── 001-add-health-endpoint/
            │   ├── events.jsonl            # Codex SDK events
            │   ├── doctor-001.log          # Doctor output attempt 1
            │   ├── doctor-002.log          # Doctor output attempt 2
            │   └── stdout.log              # Raw container stdout
            ├── 002-fix-frontend-form/
            │   ├── events.jsonl
            │   ├── doctor-001.log
            │   ├── doctor-002.log
            │   ├── doctor-003.log
            │   └── stdout.log
            └── .../
```

## 8.2 Event Types

### Orchestrator Events

```jsonl
{"ts":"2025-01-11T10:00:00Z","type":"run.start","run_id":"2025-01-11-001","project":"faangmatch","total_tasks":5}
{"ts":"2025-01-11T10:00:01Z","type":"batch.start","batch_id":1,"tasks":["001","002","004"]}
{"ts":"2025-01-11T10:00:02Z","type":"container.create","task_id":"001","container_id":"abc123","branch":"agent/001-add-health-endpoint"}
{"ts":"2025-01-11T10:00:02Z","type":"container.start","task_id":"001","container_id":"abc123"}
{"ts":"2025-01-11T10:12:00Z","type":"container.exit","task_id":"001","container_id":"abc123","exit_code":0}
{"ts":"2025-01-11T10:12:01Z","type":"task.complete","task_id":"001","attempts":1,"tokens":3421}
{"ts":"2025-01-11T10:12:02Z","type":"validator.start","validator":"test","task_id":"001"}
{"ts":"2025-01-11T10:12:30Z","type":"validator.pass","validator":"test","task_id":"001"}
{"ts":"2025-01-11T10:30:00Z","type":"batch.merging","batch_id":1,"tasks":["001","002","004"]}
{"ts":"2025-01-11T10:30:10Z","type":"batch.merged","batch_id":1,"commit":"abc123f"}
{"ts":"2025-01-11T10:30:11Z","type":"doctor.integration.start","batch_id":1}
{"ts":"2025-01-11T10:31:00Z","type":"doctor.integration.pass","batch_id":1}
{"ts":"2025-01-11T10:31:01Z","type":"batch.complete","batch_id":1}
{"ts":"2025-01-11T10:31:02Z","type":"batch.start","batch_id":2,"tasks":["003","005"]}
```

### Worker Events (Codex SDK)

```jsonl
{"ts":"2025-01-11T10:00:05Z","type":"turn.start","task_id":"001","attempt":1}
{"ts":"2025-01-11T10:00:06Z","type":"tool.start","task_id":"001","tool":"bash","command":"cat shared/schemas.py"}
{"ts":"2025-01-11T10:00:07Z","type":"tool.complete","task_id":"001","tool":"bash","exit_code":0}
{"ts":"2025-01-11T10:00:10Z","type":"tool.start","task_id":"001","tool":"write","file":"backend-public/app/routes/health.py"}
{"ts":"2025-01-11T10:00:11Z","type":"tool.complete","task_id":"001","tool":"write","file":"backend-public/app/routes/health.py","bytes":1247}
{"ts":"2025-01-11T10:00:15Z","type":"tool.start","task_id":"001","tool":"bash","command":"ruff check backend-public/"}
{"ts":"2025-01-11T10:00:18Z","type":"tool.complete","task_id":"001","tool":"bash","exit_code":0}
{"ts":"2025-01-11T10:00:20Z","type":"turn.complete","task_id":"001","tokens":1823}
{"ts":"2025-01-11T10:00:21Z","type":"doctor.start","task_id":"001","attempt":1,"command":"make test && make lint"}
{"ts":"2025-01-11T10:00:45Z","type":"doctor.pass","task_id":"001","attempt":1}
{"ts":"2025-01-11T10:00:46Z","type":"git.commit","task_id":"001","message":"[FEAT] Add /api/health endpoint","sha":"def456"}
```

### Access Request Events

```jsonl
{"ts":"2025-01-11T10:08:00Z","type":"access.requested","task_id":"002","file":"shared/validation.py","access_type":"read","reason":"Import needed for form validation"}
{"ts":"2025-01-11T10:08:01Z","type":"access.granted","task_id":"002","file":"shared/validation.py","access_type":"read"}
```

### Failure Events

```jsonl
{"ts":"2025-01-11T10:05:00Z","type":"doctor.fail","task_id":"002","attempt":1,"exit_code":1,"summary":"pytest: 2 failed"}
{"ts":"2025-01-11T10:05:01Z","type":"task.retry","task_id":"002","attempt":2,"reason":"doctor failed"}
{"ts":"2025-01-11T10:15:00Z","type":"doctor.fail","task_id":"002","attempt":2,"exit_code":1,"summary":"pytest: 1 failed"}
{"ts":"2025-01-11T10:15:01Z","type":"task.retry","task_id":"002","attempt":3,"reason":"doctor failed"}
```

### Validator Events

```jsonl
{"ts":"2025-01-11T10:12:02Z","type":"validation.start","validator":"test","task_id":"001","changed_tests":["backend-public/tests/test_health.py"]}
{"ts":"2025-01-11T10:12:28Z","type":"validation.analysis","validator":"test","task_id":"001","tests_checked":3,"concerns":[]}
{"ts":"2025-01-11T10:12:30Z","type":"validation.pass","validator":"test","task_id":"001"}
```

## 8.3 Log Query Interface

```bash
# Get all events for a task
task-orchestrator logs query --task 001

# Get all failures in a run
task-orchestrator logs query --type "*.fail"

# Get doctor output for specific attempt
task-orchestrator logs doctor --task 002 --attempt 2

# Search for error pattern
task-orchestrator logs search "ImportError"

# Summarize what happened in failed task (uses LLM)
task-orchestrator logs summarize --task 002

# Get timeline of a run
task-orchestrator logs timeline
```

---

# 9. Git Workflow

## 9.1 Branch Structure

```
main                          # Production (untouched by orchestrator)
development-codex             # Integration branch for orchestrator
├── agent/001-add-endpoint    # Task branch
├── agent/002-fix-form        # Task branch
├── agent/003-update-schema   # Task branch
└── ...
```

## 9.2 Branch Lifecycle

**Creation:**
1. Orchestrator creates branch from `development-codex`
2. Branch named: `agent/<id>-<name>`
3. Docker container checks out this branch

**During execution:**
1. Worker makes commits on task branch
2. Each commit follows project commit format
3. Commits are small and focused

**After task completion:**
1. Task branch ready for merge
2. Validators run against the branch
3. If validators pass, branch queued for merge

**Batch merge:**
1. All tasks in batch complete and validated
2. Orchestrator merges each branch sequentially into `development-codex`
3. Integration doctor runs on merged result
4. If pass, branches can be deleted
5. If fail, branches preserved for debugging

## 9.3 Commit Format

Workers follow the project's commit conventions:

```
[TYPE] Short description

Longer description if needed.

Task: 001
```

Types: FEAT, FIX, DOCS, STYLE, REFACTOR, PERF, TEST, BUILD, CI, CHORE

## 9.4 Container Git Permissions

Each container has push access only to its own branch:

**Option A: Git credential per branch**
- Configure git credential helper to allow only specific branch

**Option B: Worktree isolation**
- Container gets its own worktree
- Main repo mounted read-only
- Worktree is writable

**Option C: Separate clone**
- Container gets full clone
- Push restricted by branch protection rules on remote

---

# 10. Docker Configuration

## 10.1 Base Image

```dockerfile
FROM node:20-bookworm

# System dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-venv \
    make \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Codex CLI
RUN npm install -g @openai/codex

# Create workspace
WORKDIR /workspace

# Default command (overridden by orchestrator)
CMD ["codex"]
```

## 10.2 Container Lifecycle

**Create:**
```typescript
const container = await docker.createContainer({
  Image: projectConfig.dockerImage,
  name: `task-${taskId}-${runId}`,
  Env: [
    `CODEX_API_KEY=${secrets.codexApiKey}`,
    `CODEX_HOME=/workspace/.codex`,
    `TASK_ID=${taskId}`,
    `TASK_BRANCH=${branch}`,
    `DOCTOR_CMD=${projectConfig.doctor}`,
    `MAX_RETRIES=${projectConfig.maxRetries}`,
  ],
  HostConfig: {
    Binds: [
      `${repoPath}:/workspace:rw`,
      `${codexConfigPath}:/workspace/.codex:ro`,
    ],
    NetworkMode: 'bridge',
  },
  WorkingDir: '/workspace',
});
```

**Start:**
```typescript
await container.start();

// Checkout task branch
await container.exec(['git', 'checkout', branch]);

// Start worker
const exec = await container.exec({
  Cmd: ['node', '/worker/index.js'],
  AttachStdout: true,
  AttachStderr: true,
});
```

**Stream logs:**
```typescript
exec.output.on('data', (chunk) => {
  const line = chunk.toString();
  try {
    const event = JSON.parse(line);
    logger.write(taskId, event);
  } catch {
    logger.writeRaw(taskId, line);
  }
});
```

**Exit:**
```typescript
const result = await container.wait();
const exitCode = result.StatusCode;

if (exitCode === 0) {
  state.markComplete(taskId);
} else {
  state.markFailed(taskId);
}

// Optionally remove container
if (config.cleanupOnSuccess && exitCode === 0) {
  await container.remove();
}
```

## 10.3 Codex Configuration

```toml
# /workspace/.codex/config.toml

[model]
name = "gpt-5.1-codex-max"

[permissions]
auto_approve = true

[sandbox]
enabled = false  # Docker provides isolation

[history]
save_session = true
```

---

# 11. Worker Implementation

## 11.1 Worker Loop

```typescript
// /worker/index.js

import { Codex } from "@openai/codex-sdk";
import { execSync } from "child_process";

const taskId = process.env.TASK_ID;
const doctorCmd = process.env.DOCTOR_CMD;
const maxRetries = parseInt(process.env.MAX_RETRIES || "20");

// Load task spec
const spec = fs.readFileSync(`/workspace/.tasks/${taskId}/spec.md`, "utf-8");
const manifest = JSON.parse(
  fs.readFileSync(`/workspace/.tasks/${taskId}/manifest.json`, "utf-8")
);

// Initialize Codex
const codex = new Codex({
  env: { CODEX_HOME: "/workspace/.codex" }
});

const thread = codex.startThread({
  workingDirectory: "/workspace"
});

// Main loop
let attempts = 0;
let lastError = null;

while (attempts < maxRetries) {
  attempts++;
  
  // Build prompt
  let prompt = attempts === 1 
    ? `Execute this task:\n\n${spec}`
    : `The doctor command failed with:\n\n${lastError}\n\nPlease fix the issues and try again.`;
  
  // Execute with streaming
  logEvent({ type: "turn.start", task_id: taskId, attempt: attempts });
  
  const { events } = await thread.runStreamed(prompt);
  
  for await (const event of events) {
    logEvent({ ...event, task_id: taskId });
    
    // Check for access requests
    if (event.type === "tool.error" && event.error.includes("permission denied")) {
      const file = extractFilePath(event.error);
      logEvent({ 
        type: "access.requested", 
        task_id: taskId, 
        file,
        access_type: "read"
      });
    }
  }
  
  logEvent({ type: "turn.complete", task_id: taskId, attempt: attempts });
  
  // Run doctor
  logEvent({ type: "doctor.start", task_id: taskId, attempt: attempts, command: doctorCmd });
  
  try {
    const output = execSync(doctorCmd, { 
      cwd: "/workspace",
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    
    // Doctor passed
    logEvent({ type: "doctor.pass", task_id: taskId, attempt: attempts });
    
    // Commit
    execSync(`git add -A && git commit -m "[FEAT] ${manifest.name}\n\nTask: ${taskId}"`, {
      cwd: "/workspace"
    });
    
    logEvent({ type: "git.commit", task_id: taskId });
    
    process.exit(0);
    
  } catch (error) {
    lastError = error.stderr || error.stdout || error.message;
    
    // Write doctor output to log file
    fs.writeFileSync(
      `/workspace/.logs/doctor-${String(attempts).padStart(3, "0")}.log`,
      lastError
    );
    
    logEvent({ 
      type: "doctor.fail", 
      task_id: taskId, 
      attempt: attempts,
      summary: lastError.slice(0, 500)
    });
    
    if (attempts < maxRetries) {
      logEvent({ type: "task.retry", task_id: taskId, attempt: attempts + 1 });
    }
  }
}

// Max retries exceeded
logEvent({ type: "task.failed", task_id: taskId, attempts });
process.exit(1);

function logEvent(event) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ...event
  }));
}
```

## 11.2 Access Request Handling

When worker discovers it needs a file not in manifest:

1. Worker logs `access.requested` event
2. Worker continues executing (doesn't block)
3. If the access was critical, doctor will fail
4. On retry, orchestrator can update manifest
5. Worker retries with knowledge of what was needed

This is "fail forward" — no pause/resume complexity.

---

# 12. Validation System

## 12.1 Test Validator

**Purpose:** Ensure changed tests are legitimate, not tautological or useless.

**Trigger:** After task completion, before merge

**Implementation:**

```typescript
async function validateTests(taskId: string, changedTests: string[]): Promise<ValidationResult> {
  if (changedTests.length === 0) {
    return { pass: true, reason: "No tests changed" };
  }
  
  const testCode = changedTests.map(f => ({
    path: f,
    content: fs.readFileSync(f, "utf-8")
  }));
  
  const testedCode = await findTestedCode(changedTests);
  
  const prompt = `
You are a test validation agent. Analyze these tests for quality issues.

## Changed Tests
${testCode.map(t => `### ${t.path}\n\`\`\`\n${t.content}\n\`\`\``).join("\n\n")}

## Code Being Tested
${testedCode.map(t => `### ${t.path}\n\`\`\`\n${t.content}\n\`\`\``).join("\n\n")}

## Check For
1. Tautological assertions (always pass regardless of code)
2. Tests that don't actually test the new functionality
3. Excessive mocking that defeats the purpose
4. Missing edge cases that should be covered
5. Tests that would pass even if the feature was broken

## Output
Return JSON:
{
  "pass": boolean,
  "concerns": [
    {
      "file": "path/to/test.py",
      "line": 42,
      "issue": "Description of concern",
      "severity": "high" | "medium" | "low"
    }
  ],
  "summary": "Overall assessment"
}
`;

  const result = await llm.complete(prompt, { outputSchema: validationSchema });
  return result;
}
```

**On failure:** Task flagged for human review. Branch not auto-merged.

## 12.2 Doctor Validator

**Purpose:** Ensure doctor command is actually effective.

**Trigger:** 
- Periodically during long runs
- After suspicious patterns
- On human request

**Implementation:**

```typescript
async function validateDoctor(projectConfig: ProjectConfig): Promise<DoctorValidation> {
  const recentRuns = await getRecentDoctorRuns(10);
  const recentChanges = await getRecentChanges();
  
  const prompt = `
You are a CI/CD validation agent. Assess whether this doctor command is effective.

## Doctor Command
${projectConfig.doctor}

## Recent Doctor Runs
${recentRuns.map(r => `Attempt ${r.attempt}: ${r.passed ? "PASS" : "FAIL"}\n${r.output.slice(0, 500)}`).join("\n\n")}

## Recent Code Changes
${recentChanges.map(c => `${c.file}: ${c.summary}`).join("\n")}

## Check For
1. Is the doctor command actually running relevant tests?
2. Are there obvious gaps in coverage?
3. Could broken code slip through?
4. Is the command too slow or too fast (suspicious)?
5. Are failures actionable or cryptic?

## Output
Return JSON:
{
  "effective": boolean,
  "coverage_assessment": "good" | "partial" | "poor",
  "concerns": ["..."],
  "recommendations": ["..."]
}
`;

  const result = await llm.complete(prompt, { outputSchema: doctorValidationSchema });
  return result;
}
```

---

# 13. Failure Handling

## 13.1 Doctor Failure

```
Worker executes code
        │
        ▼
Doctor command runs
        │
        ├── PASS ──► Commit ──► Exit 0
        │
        └── FAIL ──► Log error
                        │
                        ▼
                 Attempts < max?
                        │
                ┌───────┴───────┐
                │               │
               YES              NO
                │               │
                ▼               ▼
        Feed error to      Exit 1
        Codex, retry       (Task failed)
```

## 13.2 Access Request

```
Worker needs file not in manifest
        │
        ▼
Log access.requested event
        │
        ▼
Continue execution
        │
        ▼
Doctor likely fails (missing dependency)
        │
        ▼
On retry, orchestrator sees request
        │
        ▼
Manifest updated (or human notified)
        │
        ▼
Worker retries with updated access
```

## 13.3 Container Crash

```
Container dies unexpectedly
        │
        ▼
Orchestrator detects via docker.wait()
        │
        ▼
State shows task was "running"
        │
        ▼
Check git branch for partial work
        │
        ▼
Restart container on same branch
        │
        ▼
Codex continues from committed state
```

## 13.4 Orchestrator Crash

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
        ├── status: running ──► Check container
        │       │
        │       ├── Container alive ──► Reattach
        │       │
        │       └── Container dead ──► Restart
        │
        └── status: pending ──► Schedule when ready
```

## 13.5 Unrecoverable Failure

```
Task exceeds max_retries
        │
        ▼
Mark task as "failed"
        │
        ▼
Continue batch (other tasks proceed)
        │
        ▼
At batch merge:
        │
        ├── All passed ──► Merge all, continue
        │
        └── Some failed ──► Merge passed only
                │
                ▼
        Log which tasks failed
                │
                ▼
        Continue to next batch
                │
                ▼
        Final summary shows failures
```

---

# 14. Directory Structure

## 14.1 Orchestrator

```
~/.task-orchestrator/
├── src/
│   ├── index.ts                  # CLI entry point
│   ├── cli/
│   │   ├── plan.ts               # plan command
│   │   ├── run.ts                # run command
│   │   ├── resume.ts             # resume command
│   │   ├── status.ts             # status command
│   │   ├── logs.ts               # logs command
│   │   └── clean.ts              # clean command
│   ├── core/
│   │   ├── planner.ts            # Planner LLM interface
│   │   ├── scheduler.ts          # Batch building from locks
│   │   ├── executor.ts           # Main execution loop
│   │   ├── state.ts              # State persistence/recovery
│   │   └── logger.ts             # JSONL logging
│   ├── docker/
│   │   ├── manager.ts            # Container lifecycle
│   │   ├── builder.ts            # Image building
│   │   └── streams.ts            # Log streaming
│   ├── git/
│   │   ├── branches.ts           # Branch management
│   │   └── merge.ts              # Merge operations
│   ├── validators/
│   │   ├── test-validator.ts     # Test validation
│   │   └── doctor-validator.ts   # Doctor validation
│   └── llm/
│       ├── client.ts             # LLM client abstraction
│       ├── openai.ts             # OpenAI implementation
│       └── anthropic.ts          # Anthropic implementation
├── worker/
│   ├── index.ts                  # Worker entry point
│   ├── loop.ts                   # Main retry loop
│   └── codex.ts                  # Codex SDK wrapper
├── templates/
│   ├── Dockerfile                # Base worker image
│   ├── codex-config.toml         # Codex configuration
│   └── prompts/
│       ├── planner.md            # Planner prompt template
│       ├── test-validator.md     # Test validator prompt
│       └── doctor-validator.md   # Doctor validator prompt
├── projects/                     # Project configurations
│   └── example.yaml
├── state/                        # Run state (per project)
│   └── <project>/
│       └── run-<id>.json
├── logs/                         # Run logs (per project)
│   └── <project>/
│       └── run-<id>/
│           ├── orchestrator.jsonl
│           └── tasks/
│               └── <task-id>/
│                   └── events.jsonl
├── package.json
├── tsconfig.json
└── README.md
```

## 14.2 Project Planning Artifacts

```
<project-repo>/
├── docs/
│   └── planning/
│       ├── 000-discovery/
│       │   ├── requirements.md
│       │   ├── research-notes.md
│       │   └── api-findings.md
│       ├── 001-architecture/
│       │   ├── architecture.md
│       │   ├── decisions.md
│       │   └── infrastructure.md
│       ├── 002-implementation/
│       │   ├── implementation-plan.md
│       │   └── risk-assessment.md
│       └── sessions/
│           ├── 2025-01-11-discovery.md
│           ├── 2025-01-11-architecture.md
│           └── 2025-01-12-implementation.md
└── ...
```

## 14.3 Task Artifacts (Generated by Planner)

```
<project-repo>/
├── .tasks/
│   ├── 001-add-health-endpoint/
│   │   ├── manifest.json
│   │   └── spec.md
│   ├── 002-fix-frontend-form/
│   │   ├── manifest.json
│   │   └── spec.md
│   └── .../
└── ...
```

---

# 15. CLI Interface

## 15.1 Commands

### plan

Create tickets from implementation plan.

```bash
task-orchestrator plan \
  --project faangmatch \
  --input docs/planning/002-implementation/implementation-plan.md \
  --output .tasks/
```

**Options:**
- `--project` — Project name (loads config from projects/)
- `--input` — Path to implementation plan
- `--output` — Where to write task manifests
- `--dry-run` — Show what would be created without writing

### run

Execute all pending tickets.

```bash
task-orchestrator run \
  --project faangmatch
```

**Options:**
- `--project` — Project name
- `--tasks` — Specific task IDs to run (default: all pending)
- `--max-parallel` — Override max parallel containers
- `--dry-run` — Show execution plan without running

### resume

Continue after crash.

```bash
task-orchestrator resume \
  --project faangmatch \
  --run-id 2025-01-11-001
```

**Options:**
- `--project` — Project name
- `--run-id` — Run ID to resume (default: latest)

### status

Check current run status.

```bash
task-orchestrator status \
  --project faangmatch
```

**Output:**
```
Run: 2025-01-11-001
Status: running
Started: 2025-01-11T10:00:00Z
Duration: 45m

Batches:
  [1] complete  (3 tasks, 30m)
  [2] running   (2 tasks, 15m elapsed)

Tasks:
  [001] complete  add-health-endpoint      1 attempt   12m
  [002] complete  fix-frontend-form        3 attempts  28m
  [003] running   update-schema            1 attempt   15m elapsed
  [004] complete  etl-fix                  1 attempt   25m
  [005] pending   -

Tokens used: 21,478
Estimated cost: $3.42
```

### logs

Query and view logs.

```bash
# Tail live logs
task-orchestrator logs --project faangmatch --follow

# Query specific task
task-orchestrator logs query --project faangmatch --task 002

# Search across logs
task-orchestrator logs search --project faangmatch "ImportError"

# Get doctor output
task-orchestrator logs doctor --project faangmatch --task 002 --attempt 2

# Summarize failed task (uses LLM)
task-orchestrator logs summarize --project faangmatch --task 002
```

### clean

Remove completed branches and containers.

```bash
task-orchestrator clean \
  --project faangmatch \
  --keep-logs  # Don't delete logs
```

## 15.2 Global Options

```bash
--verbose, -v       # Increase log verbosity
--config <path>     # Override config location
--help, -h          # Show help
```

---

# 16. Planner Prompt

```markdown
You are a planning agent. Your job is to convert an implementation plan into structured, executable tickets.

## Context

Project: {{project_name}}
Repository: {{repo_path}}

## Project Resources

This project has the following resources. Each ticket must declare which resources it reads and writes:

{{#each resources}}
- **{{name}}**: {{description}}
  - Paths: {{paths}}
{{/each}}

## Your Task

Given the implementation plan below, output a JSON object with this exact schema:

```json
{
  "tasks": [
    {
      "id": "001",
      "name": "short-kebab-case-name",
      "description": "One sentence description",
      "estimated_minutes": 15,
      "locks": {
        "reads": ["resource-name"],
        "writes": ["resource-name"]
      },
      "files": {
        "reads": ["path/to/file.py"],
        "writes": ["path/to/file.py"]
      },
      "affected_tests": ["path/to/test.py"],
      "verify": {
        "doctor": "make test && make lint",
        "fast": "pytest path/to/specific_test.py -x"
      },
      "spec": "Full markdown specification for this task..."
    }
  ]
}
```

## Rules

1. **Task size**: Each task should be completable in 15-60 minutes. If larger, split it.

2. **Independence**: Each task must be an independent unit of work. After completion, the codebase should be in a working state.

3. **File declarations**: Declare ALL files the task reads, including imports and dependencies. This is critical for parallelization.

4. **Resource locks**: Map file paths to the project resources. When in doubt, use the more conservative (broader) resource.

5. **Task ordering**: Order tasks so dependencies come first. Task 002 should not depend on task 005.

6. **Spec detail**: The spec field should be detailed enough that a developer (or LLM) can implement it without ambiguity. Include:
   - Exact file paths
   - Function/class names
   - Patterns to follow from existing code
   - Edge cases to handle
   - Verification steps

7. **Test coverage**: Identify which existing tests are affected. If new tests are needed, specify them in the spec.

## Implementation Plan

<implementation-plan>
{{implementation_plan}}
</implementation-plan>

## Current Codebase Structure

<codebase>
{{codebase_tree}}
</codebase>

## Existing Patterns

<patterns>
{{code_patterns}}
</patterns>

---

Output only valid JSON. No explanation or commentary.
```

---

# 17. Codex SDK Usage

## 17.1 Planner (Structured Output)

```typescript
import { Codex } from "@openai/codex-sdk";
import { readFileSync } from "fs";

async function runPlanner(
  projectConfig: ProjectConfig,
  implementationPlan: string
): Promise<Task[]> {
  const codex = new Codex();
  
  const thread = codex.startThread({
    workingDirectory: projectConfig.repoPath,
  });
  
  const prompt = buildPlannerPrompt(projectConfig, implementationPlan);
  
  const result = await thread.run(prompt, {
    outputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: taskSchema,
        },
      },
      required: ["tasks"],
    },
  });
  
  const { tasks } = JSON.parse(result.finalResponse);
  return tasks;
}
```

## 17.2 Worker (Streamed Execution)

```typescript
import { Codex } from "@openai/codex-sdk";

async function runWorker(taskId: string, spec: string): Promise<void> {
  const codex = new Codex({
    env: {
      CODEX_HOME: "/workspace/.codex",
    },
  });
  
  const thread = codex.startThread({
    workingDirectory: "/workspace",
  });
  
  const { events } = await thread.runStreamed(spec);
  
  for await (const event of events) {
    // Log every event as JSONL to stdout
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      task_id: taskId,
      ...event,
    }));
  }
}
```

## 17.3 Retry with Doctor Feedback

```typescript
async function executeWithRetry(
  taskId: string,
  spec: string,
  doctorCmd: string,
  maxRetries: number
): Promise<boolean> {
  const codex = new Codex({
    env: { CODEX_HOME: "/workspace/.codex" },
  });
  
  const thread = codex.startThread({
    workingDirectory: "/workspace",
  });
  
  let attempts = 0;
  let lastError: string | null = null;
  
  while (attempts < maxRetries) {
    attempts++;
    
    // Build prompt
    const prompt = attempts === 1
      ? `Execute this task:\n\n${spec}`
      : `The doctor command failed:\n\n${lastError}\n\nFix the issues.`;
    
    // Execute
    logEvent({ type: "turn.start", task_id: taskId, attempt: attempts });
    
    const { events } = await thread.runStreamed(prompt);
    for await (const event of events) {
      logEvent({ ...event, task_id: taskId });
    }
    
    logEvent({ type: "turn.complete", task_id: taskId });
    
    // Run doctor
    logEvent({ type: "doctor.start", task_id: taskId, attempt: attempts });
    
    const doctorResult = await runDoctor(doctorCmd);
    
    if (doctorResult.success) {
      logEvent({ type: "doctor.pass", task_id: taskId, attempt: attempts });
      await gitCommit(taskId);
      return true;
    }
    
    lastError = doctorResult.output;
    saveDoctorLog(taskId, attempts, lastError);
    
    logEvent({
      type: "doctor.fail",
      task_id: taskId,
      attempt: attempts,
      summary: lastError.slice(0, 500),
    });
    
    if (attempts < maxRetries) {
      logEvent({ type: "task.retry", task_id: taskId, attempt: attempts + 1 });
    }
  }
  
  logEvent({ type: "task.failed", task_id: taskId, attempts });
  return false;
}
```

---

# 18. Configuration Examples

## 18.1 Minimal Project Config

```yaml
# ~/.task-orchestrator/projects/my-project.yaml

repo_path: ~/projects/my-project
main_branch: development-codex
doctor: "npm test"

resources:
  - name: backend
    paths: [src/server/*]
  - name: frontend
    paths: [src/client/*]
  - name: shared
    paths: [src/shared/*]

planner:
  provider: openai
  model: o3

worker:
  model: gpt-5.1-codex-max
```

## 18.2 Full Project Config

```yaml
# ~/.task-orchestrator/projects/faangmatch.yaml

# === Repository ===
repo_path: ~/projects/faangmatch
main_branch: development-codex
task_branch_prefix: agent/

# === Execution Limits ===
max_parallel: 10
max_retries: 20
timeout_minutes: 60  # Per task

# === Resources ===
resources:
  - name: shared-types
    description: Shared type definitions and schemas
    paths:
      - shared/schemas/*
      - shared/models/*
      - shared/types/*
  
  - name: api-public
    description: Public API gateway
    paths:
      - backend-public/*
  
  - name: api-private
    description: Private matching engine
    paths:
      - backend-private/*
  
  - name: frontend
    description: Next.js frontend
    paths:
      - frontend/*
  
  - name: data-pipeline
    description: ETL and workers
    paths:
      - etl/*
      - workers-private/*
  
  - name: build-system
    description: Build and deploy configuration
    paths:
      - package.json
      - requirements*.txt
      - Makefile
      - Dockerfile*
      - infra/*

# === Verification ===
doctor: "make test && make lint && make typecheck"
doctor_timeout: 300  # seconds

# === Docker ===
docker:
  image: task-orchestrator-worker:latest
  build_context: ~/.task-orchestrator/templates
  
# === Models ===
planner:
  provider: openai
  model: o3
  temperature: 0.2

worker:
  model: gpt-5.1-codex-max
  
test_validator:
  provider: openai
  model: o3
  enabled: true

doctor_validator:
  provider: openai
  model: o3
  enabled: true
  run_every_n_tasks: 10

# === Notifications (optional) ===
notifications:
  slack_webhook: ${SLACK_WEBHOOK_URL}
  notify_on:
    - run.complete
    - task.failed
    - validation.failed
```

---

# 19. Future Enhancements

Not in scope for initial implementation, but designed for:

1. **Claude Agent SDK support** — Alternative worker engine for those preferring Anthropic

2. **Distributed execution** — Workers on remote machines or cloud instances

3. **Web UI** — Dashboard for monitoring runs, viewing logs, managing projects

4. **Cost tracking** — Detailed token usage and spend per task/run/project

5. **TDD enforcement** — Two-stage execution: write failing tests first, then implement

6. **Automated Phase 0-2** — LLM-driven discovery and architecture (with human approval gates)

7. **Multi-repo orchestration** — Coordinate changes across multiple repositories

8. **Custom validators** — Plugin system for project-specific validation

9. **Rollback automation** — Automatic rollback on integration failure

10. **Learning from failures** — Use failure patterns to improve future planning

---

# 20. Summary

The Task Orchestrator is a complete system for autonomous code execution:

**Human Phase (30-120 minutes):**
1. Discovery — Research and requirements
2. Architecture — System design
3. Implementation Plan — Ordered task breakdown

**Automated Phase (12-24 hours unattended):**
1. Planner converts plan to structured tickets
2. Orchestrator schedules parallel batches by resource locks
3. Workers execute in isolated Docker containers
4. Validators ensure test quality and doctor effectiveness
5. Branches merge to integration branch
6. System recovers from any failure

**Key Properties:**
- Project-agnostic (same tool for any codebase)
- Fully resumable (survives any crash)
- Observable (structured logs for everything)
- Safe (parallelism enforced by resource locks)
- Validated (tests and doctor verified by LLM)
- Preserved (all planning artifacts kept forever)

The system transforms human thinking into autonomous execution while maintaining safety, observability, and recoverability throughout.
