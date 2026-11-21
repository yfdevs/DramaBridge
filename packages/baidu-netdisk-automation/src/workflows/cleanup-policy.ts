/** Serialized into the client page; no module-scope dependencies. */
export function baiduCleanupProtection(entry: Record<string, unknown>, now: number, protectedPaths: string[]): string | undefined {
  const path = String(entry.path ?? "");
  if (!path.startsWith("/") || path === "/" || /[\\\0]/.test(path) || path.split("/").some(part => part === "." || part === "..")) return "路径不安全";
  const id = entry.fs_id ?? entry.fsid;
  if ((typeof id === "number" && !Number.isSafeInteger(id)) || !/^[1-9]\d*$/.test(String(id ?? ""))) return "文件身份不明";
  if (protectedPaths.some(protectedPath => path === protectedPath || path.startsWith(protectedPath + "/") || protectedPath.startsWith(path + "/"))) return "任务正在使用";
  if (/^\/(?:apps|我的应用数据|文档加工|_pcs_\.workspace|_pcs_\.safebox)(?:\/|$)/i.test(path)) return "系统目录";
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const start = Date.parse(today + "T00:00:00+08:00");
  if ([today, today.replace(/-/g, ""), today.replace(/-/g, "/"), today.replace(/^(\d+)-(\d+)-(\d+)$/, "$1年$2月$3日")].some(date => path.includes(date))) return "当天剧目";
  const timestamps = [entry.server_ctime, entry.server_mtime].map(value => {
    const number = Number(value);
    return number > 0 && Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : NaN;
  });
  if (timestamps.some(value => !Number.isFinite(value))) return "日期不明";
  if (timestamps.some(value => value >= start)) return "当天新建或更新";
  return undefined;
}
