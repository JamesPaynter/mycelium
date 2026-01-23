# Control Plane Repo Navigation Tools (Phase A)

Phase A defines the CLI surface and output contract for repository navigation.
The commands are intentionally stubbed until the navigation model is implemented.

## Command group

- `mycelium control-plane` (alias: `mycelium cp`)

## Shared flags

- `--repo <path>`: repo root to index (defaults to current working directory)
- `--base-sha <sha>`: explicit base commit for comparisons (overrides `--ref`)
- `--ref <ref>`: git ref to resolve into a base SHA later
- `--json`: emit the stable JSON envelope
- `--pretty`: pretty-print JSON output (implies JSON mode)
- `--no-build`: fail fast if the navigation model is missing

## Output envelope

When `--json` (or `--pretty`) is set, every command prints one JSON object:

```json
{ "ok": true, "result": {} }
```

or

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_NOT_BUILT",
    "message": "Control plane model not built. Run `mycelium cp build` to generate it.",
    "details": null
  }
}
```

## Error codes

- `MODEL_NOT_BUILT`: query requires a navigation model that is not available
- `NOT_IMPLEMENTED`: the command is a stub (builder not wired yet)

## Phase A command surface

- `cp build`
- `cp info`
- `cp components list`
- `cp components show <id>`
- `cp owner <path>`
- `cp deps <component>`
- `cp rdeps <component>`
- `cp blast ...`
- `cp symbols find ...`
- `cp symbols def ...`
- `cp symbols refs ...`

## Phase B extensions

- `cp blast --run <runId> --task <taskId>` reads per-task blast artifacts (or recomputes deterministically if missing).

## Stub behavior

- All commands return exit code `1` with a structured error until implemented.
- `--help` paths exit `0` and print standard help output.

## Run pinning (Phase B)

- Runs persist `control_plane.base_sha` (plus model metadata when available) at start.
- The base SHA is written immediately after checkout so failed runs remain auditable.
- Resume reuses the stored snapshot so base SHA and model hash stay fixed mid-run.
