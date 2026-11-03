import path from "node:path";

type DownloadRecord = { localPath?: string; downloadDir?: string; state: string };
const key = (value: string) => path.resolve(value).toLowerCase();
function overlaps(left: string, right: string) {
  const a = key(left), b = key(right);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

// A quiet directory is not evidence that it is disposable. Never sweep unknown
// native-client download directories, or directories used by unfinished records.
export function canCleanupPlayletDirectory(candidate: string, records: DownloadRecord[], protectedPaths: Iterable<string>) {
  for (const protectedPath of protectedPaths) if (overlaps(candidate, protectedPath)) return false;
  for (const record of records) {
    if (record.downloadDir && overlaps(candidate, record.downloadDir)) return false;
    if (record.state !== "completed" && record.localPath && overlaps(candidate, record.localPath)) return false;
  }
  return records.some(record => record.state === "completed" && record.localPath && key(record.localPath) === key(candidate));
}
