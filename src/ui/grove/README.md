# Mycelium Grove (embedded visualiser)

This package is built into `dist/ui/grove/` and mounted by the Mycelium UI Garden tab.

## Install + build
From the Mycelium repo root:

```bash
npm --prefix src/ui/grove install
npm run build:ui
```

## Runtime config (no rebuild)
- `src/ui/grove/public/sprite-actions.json`

Edit and reload the UI to change which animations are used per `(role × action)`.

## Notes
- Asset URLs are served under `/grove/*`.
- The bundle entrypoint is `mycelium-grove.mjs` and exports `mountMyceliumGrove(...)`.
