# Efficient Ralph Loops

Runs an Codex / Claude Code in a bash loop inside Docker until the project marks itself done. Two scripts—one for OpenAI Codex, one for Anthropic Claude—mount your project, feed instructions, and exit when the done pattern appears in the TODO file.


## Why?

Ralph loops work well! Sometimes... And they have issues:

- Ralph loops are inefficient, and burn tokens quickly.
- Agents WILL write bad tests just to satisfy exit conditions
- Context resets each loop with no memory of what was tried

Efficient Ralph Loops adds structure:

- Agent works from a TODO list, one task per iteration
- Each task has clear acceptance criteria
- Git commits preserve progress between loops
- Loop stops when all tasks are marked complete


## Contents

- `Dockerfile` — builds `agent-loop` image (Node 20 + `@openai/codex` + `@anthropic-ai/claude-code`)
- `loop-codex.sh` — Codex loop
- `loop-claude.sh` — Claude loop
- `YOUR_PROJECT/` — sample project (black hole ray tracer)
- `LICENSE` — MIT

## Prerequisites

- Docker
- API key or subscription auth (see below)

## Build

```sh
docker build -t agent-loop .
```

## Usage

Scripts mount `YOUR_PROJECT` as `/workspace`, read `INSTRUCTIONS.md`, and poll `TODO.md` for `[x] ALL_TASKS_COMPLETE`.

### Codex

```sh
CODEX_API_KEY=sk-... ./loop-codex.sh
# or
OPENAI_API_KEY=sk-... ./loop-codex.sh
```

### Claude (API key)

```sh
ANTHROPIC_API_KEY=sk-... ./loop-claude.sh
# or
CLAUDE_API_KEY=sk-... ./loop-claude.sh
```

### Claude (subscription auth - macOS)

Use your Pro/Max subscription instead of an API key:

```sh
# One-time setup: extract OAuth token from keychain
mkdir -p ~/.claude
security find-generic-password -s "Claude Code-credentials" -w > ~/.claude/.credentials.json
```

Then:

```sh
./loop-claude.sh
```

Script mounts `~/.claude` and `~/.claude.json` automatically.

## Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Print config, don't run |
| `--once` | Single iteration |

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_DIR` | `./YOUR_PROJECT` | Project path |
| `INSTRUCTIONS_FILE` | `$PROJECT_DIR/INSTRUCTIONS.md` | Agent instructions |
| `DONE_FILE` | `$PROJECT_DIR/TODO.md` | Completion file |
| `DONE_PATTERN` | `\[x\] ALL_TASKS_COMPLETE` | Done regex |
| `SLEEP_SECONDS` | `2` | Loop delay |
| `MAX_LOOPS` | `0` | Iteration cap (0 = unlimited) |
| `STDOUT_MODE` | `stream` | `stream`, `quiet`, `log`, `log_only` |
| `LOG_DIR` | `./logs` | Log output dir |
| `IMAGE` | `agent-loop:latest` | Docker image |
| `MODEL` | `opus` | Claude model |

## Customization

Replace `YOUR_PROJECT/` contents with your own. Update `TODO.md` tasks and mark `[x] ALL_TASKS_COMPLETE` when done.

## Security

Both scripts bypass approval prompts (`--dangerously-bypass-approvals-and-sandbox` for Codex, `--dangerously-skip-permissions` for Claude). Run on isolated/trusted workspaces only.
