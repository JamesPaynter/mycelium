# Error handling runbook

Use this runbook when the CLI reports an error and you need more detail.

## Default CLI error output
- Short, single block on stderr.
- Title + message, with optional `Hint:` and `Next:` lines.
- Stack traces are hidden by default.

Example shape:
```text
Error: <title>
<message>
Hint: <what to try>
Next: <what to do next>
```

## Debug output (--debug)
- Add `--debug` to include error code, error name, cause, and stack trace.
- Use the global flag form to ensure it applies: `mycelium --debug <command> ...`.

Example shape:
```text
Error: <title>
<message>
Hint: <what to try>
Next: <what to do next>
Code: CONFIG_ERROR
Name: UserFacingError
Cause: <original error message>
Stack:
  <stack trace>
```

## Control-plane JSON output
- For control-plane commands with `--json`, failures return a JSON envelope.
- Add `--debug` to include extra error details in the `error.details` payload.

Example:
```bash
mycelium --debug cp components list --json
```

## Triage checklist
1) Rerun the failing command with `--debug`.
2) Capture the full stderr output, the command you ran, and the run id.
3) Review logs for context: `mycelium logs failures --project <name>` or `mycelium logs doctor --project <name>`.

If the error points to config or task layout issues, verify `.mycelium/config.yaml` and the task manifests.
