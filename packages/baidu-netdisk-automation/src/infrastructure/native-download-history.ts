import type { NativeTask } from "./native-download-status.js";

/** Client 8.9.7's completed-record surface is app.$getHistoryRecord, type=2.
 * History is a positive existence hint only: disk validation remains required.
 */
export function decodeNativeDownloadHistory(payload: { errorNo?: unknown; json?: unknown } | undefined): NativeTask[] {
  if (!payload || Number(payload.errorNo) !== 0) throw new Error("客户端下载历史暂不可用，不能确认任务缺失");
  let decoded = payload.json;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded); } catch { throw new Error("客户端下载历史格式不可用"); }
  }
  const items = (decoded as { history_items?: unknown } | undefined)?.history_items;
  if (!Array.isArray(items)) throw new Error("客户端下载历史格式不可用");
  return items.filter(item => item && typeof item === "object" && String(item.is_download) === "1")
    .map(item => ({
      id: item.trans_id,
      name: String(item.local_path || "").split(/[\\/]/).filter(Boolean).pop(),
      local_path: item.local_path,
      server_path: item.server_path,
      // Do not infer successful content from a history record or unknown flags.
      status: "客户端历史记录（本地待核验）",
    }));
}
