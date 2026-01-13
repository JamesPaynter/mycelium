# Agent Loop Harness

This repo is a tiny harness for running an LLM agent in a loop inside Docker until a project signals it is done. It ships two loop scripts—one for OpenAI Codex and one for Anthropic Claude—that mount `YOUR_PROJECT` into the container, feed in instructions, and stop when the done pattern appears in the project's TODO file.

## What’s here
- `Dockerfile` builds the `agent-loop` image (Node 20 with `@openai/codex` and `@anthropic-ai/claude-code` CLIs).
- `loop-codex.sh` runs the Codex loop; `loop-claude.sh` runs the Claude loop.
- `YOUR_PROJECT/` holds the work-in-progress project, placeholder instructions, and a sample plan (a black hole ray tracer).
- `LICENSE` is MIT.

## Prerequisites
- Docker installed and running.
- API key for the agent you plan to use: `CODEX_API_KEY`/`OPENAI_API_KEY` for Codex, or `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` for Claude.

## Build the image
```sh
docker build -t agent-loop .
```

## Running the loops
By default the scripts mount `YOUR_PROJECT` as `/workspace`, read instructions from `YOUR_PROJECT/INSTRUCTIONS.md`, and watch `YOUR_PROJECT/TODO.md` for `[x] ALL_TASKS_COMPLETE`.

### Codex
```sh
CODEX_API_KEY=sk-... ./loop-codex.sh
```

### Claude
```sh
ANTHROPIC_API_KEY=sk-... ./loop-claude.sh
```

## Flags and environment
- `--dry-run` prints the resolved settings without starting the loop.
- `--once` runs a single iteration.
- `PROJECT_DIR`, `INSTRUCTIONS_FILE`, `DONE_FILE`, `DONE_PATTERN` override the defaults if you want to point at a different project or completion marker.
- `SLEEP_SECONDS` sets the pause between iterations; `MAX_LOOPS` caps the number of passes (0 runs until done).
- `STDOUT_MODE` controls logging: `stream` (default), `quiet`, `log` (also writes to `logs/`), or `log_only`.
- `IMAGE` overrides the Docker image tag; `MODEL` chooses the Claude model.

Both scripts pass the instructions file to the agent each loop and stop when the done pattern is found. The Codex script uses `codex exec` with `--dangerously-bypass-approvals-and-sandbox`; run it only on isolated workspaces you trust.

## Customizing the project
Edit the files under `YOUR_PROJECT/` to define your own tasks, instructions, and completion criteria. The sample `PLAN.md` sketches a Python black hole ray tracer, but you can replace it with any project. Update `TODO.md` to reflect real tasks and mark them complete to end the loop.
