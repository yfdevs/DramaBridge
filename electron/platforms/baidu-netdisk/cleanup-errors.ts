export type CleanupBatch = { index: number; kind: "files" | "empty-directory"; count: number; bytes: number; confirmedBatches: number };
export type CleanupPauseKind = "identity" | "risk" | "capacity" | "unknown";

/** Keep diagnostic stacks in the journal/log; expose only actionable messages through IPC. */
export function describeCleanupPause(raw: string): { message: string; pauseKind: CleanupPauseKind; batch?: CleanupBatch } {
  let batch: CleanupBatch | undefined;
  const encoded = raw.match(/\[BAIDU_CLEANUP_BATCH\] (\{[^\n]{1,1000}\})/);
  if (encoded) {
    try {
      const value = JSON.parse(encoded[1]);
      if ([value.index, value.count, value.bytes, value.confirmedBatches].every(n => Number.isSafeInteger(n) && n >= 0) && value.index > 0 && value.count > 0 && ["files", "empty-directory"].includes(value.kind)) batch = { index: value.index, kind: value.kind, count: value.count, bytes: value.bytes, confirmedBatches: value.confirmedBatches };
    } catch { /* Legacy/partial diagnostics must not hide the actual pause. */ }
  }
  if (/BAIDU_NETDISK_IDENTITY_VERIFICATION|errno\s*[=:]\s*132\b/.test(raw)) return { message: "百度要求身份验证，自动清理已暂停；请在网盘客户端完成验证后再恢复。", pauseKind: "identity", batch };
  if (/BAIDU_NETDISK_RISK_CONTROL/.test(raw)) return { message: "网盘限制了当前操作，自动清理已暂停；请检查客户端提示，稍后手动恢复。", pauseKind: "risk", batch };
  if (/容量尚未下降/.test(raw)) return { message: "删除后容量尚未下降，自动清理已暂停；请核对容量和回收站，不会自动清空回收站。", pauseKind: "capacity", batch };
  const firstLine = raw.replace(/\[BAIDU_CLEANUP_BATCH\] \{[^\n]*\}\s*/, "").split(/\r?\n/)[0].replace(/^(?:执行网盘脚本：)?(?:Error:\s*)?/, "").trim();
  const message = /<anonymous>|\bat (?:async )?\w+|request_id=|endpoint=/.test(firstLine) ? "清理未完成，已暂停；请先核对当前目录后再恢复。" : firstLine.slice(0, 180) || "清理未完成，请核对后再恢复。";
  return { message, pauseKind: "unknown", batch };
}
