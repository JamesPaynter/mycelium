# agents.md

Repository guidelines and operating instructions for humans and automation agents.
Goal: enable safe changes with minimal back-and-forth by documenting system topology,
local dev workflow, configuration, and verification steps.


## Coding style & conventions

Follow **Easy Scan** principles throughout. Code should be readable at a glance.

### Code style: Easy Scan

Code should be scannable at a glance. Optimize for quick comprehension, not brevity.

#### Naming

- Descriptive names, no abbreviations (`user_resume_text` not `txt`)
- Functions say what they do (`load_job_index_from_disk` not `load`)
- Booleans read as questions (`is_ready`, `has_loaded`, `should_retry`)

#### Structure

- Code flows top-to-bottom, no jumping around
- One responsibility per function
- Related functions grouped together
- Early returns to reduce nesting

#### Section headers

Use visual breaks between logical sections in files with multiple concerns:

```python
# =============================================================================
# DATA LOADING
# =============================================================================

def load_job_index_from_disk(path: Path) -> list[dict]:
    ...


def load_job_vectors_from_disk(path: Path) -> np.ndarray:
    ...


# =============================================================================
# MATCHING LOGIC
# =============================================================================

def compute_cosine_similarity(query_vector: np.ndarray, corpus: np.ndarray) -> np.ndarray:
    ...
```

#### Comments

- Explain WHY, not WHAT
- Add context that isn't obvious from the code
- No commented-out code - delete it or use git history

#### Whitespace

- Blank lines between logical blocks
- Two blank lines before section headers
- Don't cram related code together

Python:

- 4-space indentation
- snake_case functions/variables
- PascalCase classes

TypeScript/React:

- 2-space indentation
- PascalCase components
- camelCase props

Shared code:

- Keep `shared/` import-only; do not introduce app startup side effects in `shared/`.


## Repo navigation tools

Prefer `mycelium cp` Control Plane navigation queries before grepping when you need
ownership, dependencies, blast radius, or symbol info.

Command cheat sheet:

```bash
mycelium cp components list
mycelium cp owner <path>
mycelium cp blast <path>
mycelium cp symbols find <query>
mycelium cp symbols def <symbol>
mycelium cp symbols refs <symbol>
```


## PR and commit requirements

Commits:

- use bracketed type prefixes. Recommended set (pick one per commit):
  - `[FEAT]` new functionality
  - `[FIX]` bug fix
  - `[DOCS]` documentation-only change
  - `[STYLE]` formatting/whitespace; no logic
  - `[REFACTOR]` internal code change without behavior change
  - `[PERF]` performance improvement
  - `[TEST]` add/adjust tests
  - `[BUILD]` build system or dependencies
  - `[CI]` continuous integration config/scripts
  - `[CHORE]` maintenance/housekeeping
  - `[REVERT]` revert a prior commit

PRs must include:

- services affected 
- what changed and why
- verification steps run (paste commands)
- screenshots for UI changes
- linked issue (if any)

## Project Tracking

- `ROADMAP.md`: long-term goals and future work; move items into `TODO.md` when ready to start.
- `TODO.md`: current active tasks; focus on one effort at a time; after completion, summarize and move to `CHANGELOG.md`.
- `CHANGELOG.md`: completed work with dates and brief summaries.
- `docs/history/`: dated snapshots of TODO lists; keep detailed task lists archived even after summarizing into `CHANGELOG.md`.
- Workflow: `ROADMAP → TODO → CHANGELOG`.
- When closing out a TODO batch, both: (1) summarize into `CHANGELOG.md`, and (2) save the full TODO list to `docs/history/todo-YYYY-MM-DD.md` to retain detailed context.

## Task Management System

Each TODO item links to a detailed task folder in `docs/tasks/`.

### Directory Structure

```
docs/tasks/
├── _template/              # Copy to start new task
│   ├── spec.md
│   ├── scratchpad.md
│   └── lessons-learned.md
├── active/                 # Tasks in progress
│   └── NNN-task-name/
│       ├── spec.md         # Full specification
│       ├── scratchpad.md   # Working notes
│       └── lessons-learned.md
└── archive/                # Completed tasks
```

### Task Files

**spec.md** - Full task specification:
- Status checkboxes (Scoped / In Progress / Implemented / Verified)
- Summary (one-liner)
- Model & Effort (Effort + Tier + model/reasoning selection)
- Files Changing (table: file, change type, description)
- Blast Radius (scope, risk level, rollback strategy)
- Implementation Checklist
- Verification steps
- Dependencies (blocks / blocked by)

### Effort & Model Selection

Use the Effort/Tier system for estimating and choosing a model:

- **Effort**: XS / S / M / L / XL
- **Tier**: mini / standard / pro

Model mapping:
- **Tier mini** → `gpt-5.1-codex-mini` (default reasoning)
- **Tier standard** → `gpt-5.1-codex` (default reasoning)
- **Tier pro** → `gpt-5.1-codex-max` (Reasoning: Extra high / supermax)

**scratchpad.md** - Working notes during implementation:
- Session-dated entries
- Commands run and their output
- Discoveries and findings
- Open questions

**lessons-learned.md** - Post-completion reflection:
- What went well
- What was tricky
- Unexpected discoveries
- Recommendations for AGENTS.md / CLAUDE.md
- Time spent per phase

### Task Lifecycle

1. **Create**: Copy `_template/` → `active/NNN-task-name/`
2. **Scope**: Fill out `spec.md` completely before coding
3. **Work**: Update `scratchpad.md` as you go
4. **Complete**: Mark spec.md status boxes, fill `lessons-learned.md`
5. **Archive**: Move folder to `archive/`
6. **Integrate**: Cherry-pick lessons into AGENTS.md / CLAUDE.md

### TODO.md Format

Link each item to its spec:

```markdown
- [ ] [001 - Task name](docs/tasks/active/001-task-name/spec.md) (Effort S, Tier standard)
```

When complete, update link to archive:

```markdown
- [x] [001 - Task name](docs/tasks/archive/001-task-name/spec.md) (Effort S, Tier standard)
```

## Development Workflow

Starting work:

- Pull latest main.
- Create a branch from the TODO item: `git checkout -b <descriptive-branch-name>`.
- Read `TODO.md` to confirm the task has enough detail; if unclear, flesh out the plan before coding.

During work:

- Implement step by step; keep commits small and focused.
- Commit frequently.
- If scope grows, update `TODO.md` with new subtasks.

Completing work:

- Check off items in `TODO.md`.
- Add a dated summary to `CHANGELOG.md`.
- Commit tracking file updates.
- Squash merge to main (or your preferred merge strategy).

Branch naming:

- Use descriptive names tied to the task, e.g., `refactor/data-paths`, `feat/dev-prod-environments`.


## Compatibility policy

- Single environment owner; avoid legacy or back-compat branches in code and data. When changing paths, IDs, or APIs, migrate in-place and remove fallbacks to keep the surface area minimal.


## Agentic design patterns (Shrivu rules)

Purpose: make outputs, interfaces, and structure agent-friendly so work stays fast and verifiable.

### Rule 1: Every output is a prompt

- Directive: Treat every tool interaction as a conversational turn that points to the next action.
- Success pattern: confirmation + IDs + next command(s). Example: `Success! Deployment ID: deploy-a1b2c3d4. Next: ./get-status --id deploy-a1b2c3d4`
- Failure pattern: what broke, how to fix, what to run next. Example: `Deploy failed: missing DB_URL. Fix: export DB_URL and rerun ./deploy --service api. Next: ./get-status --id deploy-a1b2c3d4`

### Rule 2: Make code and tools self-documenting

- Directive: Keep critical guidance local; avoid forcing the agent to hunt for a wiki.
- CLI: `--help` is canonical and must include flags, defaults, and copy/paste examples for the common paths.
- Code: top-of-file comment blocks for purpose, key assumptions, and common usage patterns. Inline docstrings only when they add non-obvious context.
- Runbooks: when a workflow is tricky, embed the minimal runbook near the code and link it from error messages.

### Rule 3: Choose the right interface (CLI vs MCP)

- Directive: pick the protocol that best fits agent workflows and validation needs.
- CLI: good for shell chaining; keep syntax forgiving (sensible defaults) and examples close to real usage. Example: `read-logs --name my-service-logs --since 2h`
- MCP: good for structured calls and stricter validation; expose clear schema, required fields, defaults, and a minimal example. Example: `read_logs(name: "my-service-logs", since: "2h")`

### Rule 4: Use familiar metaphors

- Directive: model new surfaces after well-known tools so the agent can transfer prior knowledge.
- Examples: tests feel like pytest (fixtures, asserts); data transforms feel like pandas (chainable verbs); deploy flows feel like docker/kubectl (verbs/nouns are predictable).

### Rule 5: Design for workflows, not concepts

- Directive: co-locate code that changes together and optimize for sequential edits.
- Examples: feature-based folders in monorepos; domain-based backend modules (`products/product_api.py`, `product_service.py`, `product_model.py`); component-scoped UI folders (`components/Button/index.jsx`, `Button.module.css`, `Button.test.js`).
- Constraint: do not fight established framework conventions when they already aid locality (e.g., keep Next.js expectations intact).

### Rule 6: Prove correctness with programmatic evidence

- Directive: go beyond green unit tests; gather evidence that builds merge confidence.
- Requirements: cover critical workflows end-to-end and emit artifacts that show behavior, not just pass/fail (logs, metrics, traces, screenshots or recordings for UI).
- When possible: include quick verification commands in output so the agent can re-run checks without context hunting.
