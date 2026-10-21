# Electron main process

The Electron directory is organized by responsibility:

- `main.ts` is the composition root. It registers app-level services and wires lifecycle events.
- `core/` contains platform-independent application shell concerns such as paths, windows, shutdown, and small infrastructure utilities.
- `ipc/` owns the tRPC transport, validated invocation envelope, and the central main-process procedure registry. Request/response IPC must register through this layer instead of calling Electron's `ipcMain.handle` directly.
- `platforms/<platform>/index.ts` is the main-process adapter for one publishing platform. Each platform has its own directory so related tests and supporting modules stay inside the same boundary.
- `platforms/shared/` contains reusable Electron/platform boundary helpers such as configuration validation, storage operations, runtime coordination, and task analytics. It must not contain platform business rules.
- `platforms/registry.ts` is the only composition point that registers all platform adapters.
- `storage/` contains SQLite schemas and repositories. Platform adapters call repositories instead of issuing ad-hoc SQL.
- `preload.ts` is the renderer bridge and should stay free of platform business logic.
- `app-*.ts`, `global-app-config.ts`, and the logger modules provide application-wide services.

When adding behavior, keep automation and website interaction inside `packages/<platform>-automation/`. The Electron adapter should only translate persisted desktop configuration and IPC requests into runtime options.

New platform-specific files belong under the matching `platforms/<platform>/` directory. Do not reintroduce flat `platforms/<platform>.ts` files or copy shared filesystem/runtime helpers into a platform adapter.

Renderer request/response calls keep the compatibility-facing `window.ipcRenderer.invoke` method, but preload routes it through the tRPC client. Electron event channels remain available only for main-process broadcasts and window controls.
