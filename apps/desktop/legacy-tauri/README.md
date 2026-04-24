# Legacy Tauri Runtime

This directory keeps the short-lived Tauri rollback path outside the main Electron
build, test, and release flow.

- `run-tauri.mjs` is an explicit fallback entrypoint only.
- `renderer/tauriRuntime.ts` is retained for historical reference while the
  Electron cutover settles.
- Nothing in this directory is part of the default desktop workflow or CI.
