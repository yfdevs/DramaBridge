# Baidu Netdisk Automation

Windows Baidu Netdisk CDP automation package.

The package keeps Promise-based public APIs for Electron callers and also exports
Effect programs for typed failures, polling, retry, and scoped CDP resources.
The Electron platform module must inject the configured runtime log file through
`configureBaiduNetdiskAutomationLogging`; the automation package does not read
desktop configuration or environment variables itself.

The public CLI flow lives in `src/download-baidu-folder.ts`. The package entry
exports CDP status and launch helpers used by the Electron main process. Internal
code is split by responsibility:

```text
src/
  domain/          # types, constants, typed errors, share-text parsing
  infrastructure/  # CDP transport, logging, low-level utilities
  runtime/         # Effect helpers and Baidu client lifecycle
  workflows/       # download orchestration
  entrypoints/     # CLI argument parsing
  index.ts         # stable library facade
  download-baidu-folder.ts # stable CLI/package facade
tests/             # mirrors the src structure
```

```powershell
pnpm --filter @dramabridge/baidu-netdisk-automation check
pnpm --filter @dramabridge/baidu-netdisk-automation test
pnpm --filter @dramabridge/baidu-netdisk-automation build
pnpm --filter @dramabridge/baidu-netdisk-automation download:share -- --share-file=D:\path\share.txt
```
