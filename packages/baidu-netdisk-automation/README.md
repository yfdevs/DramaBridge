# Baidu Netdisk Automation

Windows Baidu Netdisk CDP automation package.

The package keeps Promise-based public APIs for Electron callers and also exports
Effect programs for typed failures, polling, retry, and scoped CDP resources.
The Electron platform module must inject the configured runtime log file through
`configureBaiduNetdiskAutomationLogging`; the automation package does not read
desktop configuration or environment variables itself.

The public CLI flow lives in `src/download-baidu-folder.ts`. The package entry
exports CDP status and launch helpers used by the Electron main process.

Before saving a share or creating download tasks, the workflow probes the native
downloader without changing its task queue. A client component load failure
(including stale ASAR offsets after an in-place update) reports
`BAIDU_NETDISK_CLIENT_RESTART_REQUIRED`. Restarting CDP must actually terminate
the old client processes; process-query and termination failures are not treated
as a successful restart.

Startup first tries the installed executable unchanged. If that client removes
the debugging switch, DramaBridge automatically prepares an isolated launcher
in its run-data cache. The copied executable and native libraries retain their
original bytes; a DramaBridge-owned bootstrap preserves the requested local
debugging port while loading the client's original entrypoint, modules and login
paths. Nothing is patched in the Baidu installation. The package entrypoint is
read from the installed ASAR metadata rather than a hard-coded version or script
path. Cache identities include executable hashes, runtime files and ASAR update
times, so a client update prepares a fresh launcher. Existing cached executables
are checked before reuse. Startup succeeds only after CDP and the native download
API are both available.

Share navigation uses a reusable, dedicated client window with the existing
session. It does not navigate the client's homepage, download manager or AI
assistant to an external share. Readiness continuously checks extraction forms,
including hidden forms while the page says it is extracting, and follows target
replacement. Verification requests have an 8-second network timeout and may
fall back to the real form. Success requires share metadata and a usable file
list; a navigation event or the words “全部文件” on the user's own disk are not
success. Blank pages get one refresh per target, missing/stalled pages get at
most two reopens, and the readiness loop has a 90-second budget. Captchas and
invalid shares fail explicitly without refreshing away their error state.

CDP script evaluation allows 60 seconds by default for a busy native client;
short readiness probes retain their explicit budgets. Directory transfer and
material scans retain their separate 10-minute budget. Requests inside that
script abort after 30 seconds, including reading the response body, so a stalled
HTTP request reports its endpoint instead of consuming the entire script budget.
Timeouts preserve their typed error, stage and duration. The transport never
replays a timed-out script: a transfer or download submission may already have
taken effect and must be reconciled before retrying.

Internal code is split by responsibility:

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
