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

Directory scans share a task-scoped cache (including pending reads). Transfers,
copies and directory creation invalidate affected listings; failed or incomplete
pages are never treated as a complete cache. Exact reusable root matches avoid
optional global searches. Uploads reconcile fresh directory contents before
creating a share, and use exact file metadata instead of repeatedly listing a
whole directory after every file.

Share root reads explicitly select `root=1`; nested reads use `root=0` and the
full server-returned path. Fresh verified-link HTML takes precedence over a
reused page's stale `yunData`. Client `/sharelink...` aliases are only mapped to
real root paths when their file IDs match a complete fresh root listing; they
are never resolved by stripping a prefix or matching a basename. Invalid root
responses (`-9`), expired login, and verification errors stop before transfer
instead of falling back to cached HTML. Directory failures include request IDs;
partial or malformed lists are not cached as empty directories.

Share-page and upload metadata requests reserve starts at least 400 ms apart.
Upload data transfers have a separate 20 ms start interval and share the same
risk circuit. These are conservative application defaults, not a published Baidu
rate limit. Risk/verification responses such as 8001/8011 and HTTP 429 open a
60-second circuit, include endpoint/errno/request_id diagnostics, and stop automatic
retries. The Electron operation queue also rejects new cloud operations during
that cooldown. Complete any verification in the actual client before retrying;
switching upload servers must never bypass a risk response.

Web uploads discover PCS servers through `locateupload`, cache them for 60 seconds,
and keep restricted HTTPS PCS fallbacks. Only the same upload session/block may
retry on another server after a transport failure. Final create requests are
reconciled by metadata/content verification after an uncertain response rather
than replayed. Verified receipts continue to support recovery without uploading
the same content again.

Two files run through transfer/commit/verification concurrently. Each file has
at most four part requests in flight, for an eight-part total budget. The shared
node is warmed once per task. One file's content verification can overlap the
next file's transfer; verification must still finish before sharing. A failure
cancels and drains peer files and parts, and stops new work. Complete content
readback and persisted receipts remain in place when server checksums differ.

Part bytes no longer cross CDP as Base64. A small descriptor selects the local
file, offset, size, expected timestamp and checksum; the client's main process
reads and hashes the part, closes the file, builds multipart bytes and uploads
through its logged-in Electron session. Changed files fail before HTTP submission.
Cancelled/timed-out local reads cannot submit a late request. Only validated PCS
upload endpoints accept this descriptor. Directory cache updates are chained so
parallel commits cannot overwrite each other's entries. Complete commit metadata
is reused instead of issuing a redundant filemetas request. Per-file transfer and
verification timings, throughput, and batch timing are sent through onProgress;
Electron retains these stage metrics in the netdisk log.

Error 132 on file management requires identity verification in the Baidu client
for that operation. It uses `BAIDU_NETDISK_IDENTITY_VERIFICATION`, stops the
denied operation without retrying, and does not open the global upload circuit.
Required conflict deletion/renaming remains blocking and reports its action/path.
Optional old sibling-directory cleanup happens after a verified share is created;
failure keeps both the old directory and successful share result, reports a
warning, and never automatically retries a denied deletion. Subsequent upload
tasks can continue; an unrelated active 8001/8011 circuit remains in force.

Native task reads and controls have a separate per-port serial lane because the
installed client stores callbacks in shared module variables. Task controls use
the verified array-of-IDs API. Cleanup is limited to the validated disposable
download root and confirms that deleted active tasks disappear before local
files are removed. Completed-record lookup is a positive existence fallback;
it does not replace local file validation. See the repository's
`internal/research/baidu-netdisk-8.9.7-analysis.md` and read-only diagnostic script
for client-version evidence, supported interfaces, and remaining unknowns.

Active-task and history callbacks now execute inside Baidu's main process and
serialize their payload immediately to JSON. Only that string crosses
`@electron/remote`; the renderer never retains an `items.tasks` remote proxy
that can expire before inspection. Main-process reads have bounded timeouts;
disposed-object errors reconnect and retry the read once. Neither timeout nor
malformed snapshots count as an empty queue. After a submission error, reconcile
the queue before considering another write; an already complete local file also
confirms a single-file submission when queue inspection fails. Unknown results
remain blocking, preserving the no-duplicate-download rule.

Kuaishou recreation versions now reuse the first successfully shared sibling in
the same task and canonical drama directory. Local video preparation copies bytes
and changes names; the upload workflow matches by relative category, size and
content MD5 rather than filename. Matching files use one cloud `copy` operation
with their final `newname` (batches of at most 50); changed files retain normal
multipart upload. Each version retains its own directory and share link. The
source version is left intact. This removes repeat video transfers for versions
that only change names, while retaining local preparation and checksum work.

Source receipts must still match fresh source metadata. Target size/checksum and
unchanged source metadata establish copied-file receipts; unavailable lineage
falls back to actual content verification. A returned task ID requires terminal
success and per-item checks before sharing. Uncertain responses are reconciled
without replaying the copy or starting a conflicting upload. Existing verified
targets are reused after restart. Missing/unreadable sources before any copy
fall back to ordinary upload; risk and identity verification remain blocking.
The client protocol evidence and limits of static analysis are documented in
`internal/research/baidu-cloud-copy-analysis.md`. Tests exercise mocked cloud
responses; no real account copy was performed during implementation.

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
