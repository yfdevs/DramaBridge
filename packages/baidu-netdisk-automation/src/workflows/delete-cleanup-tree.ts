import type { CleanupEntry, CleanupDirectory } from "./cleanup-account.js";
import type { baiduCleanupProtection } from "./cleanup-policy.js";

/** Serialized into the account page. Ordinary deletes only; never retry a challenged write. */
export async function deleteBaiduCleanupTreeInPage(
  request: <T>(url: string, init?: RequestInit, format?: "json" | "text", timeout?: number) => Promise<T>,
  protect: typeof baiduCleanupProtection,
  options: { root: CleanupDirectory; entries: CleanupEntry[]; timeoutMs?: number; pollIntervalMs?: number; singleFile?: boolean },
): Promise<{ deleted: boolean; batches: number; bytes: number }> {
  const controller = new AbortController();
  const budget = options.singleFile ? Math.min(900_000, Math.max(180_000, options.entries.length * 4000 + 60_000)) : 180_000;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? budget);
  const root = options.root;
  const startDay = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const host = globalThis as unknown as { locals?: { get?: (key: string) => unknown }; yunData?: { bdstoken?: string } };
  const token = String(host.locals?.get?.("bdstoken") || host.yunData?.bdstoken || "");
  const params = () => new URLSearchParams({ channel: "chunlei", web: "1", app_id: "250528", clienttype: "0", bdstoken: token });
  let batches = 0, bytes = 0;
  const check = () => {
    controller.signal.throwIfAborted();
    if ((globalThis as unknown as { __dramaBridgeAutoCleanupContinue?: boolean }).__dramaBridgeAutoCleanupContinue === false) throw new Error("自动清理已关闭，停止后续删除");
    if (new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) !== startDay) throw new Error("日期已变化，暂停清理并重新检查当天保护");
  };
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const list = async (dir: string, findPath?: string) => {
    const all: CleanupEntry[] = [];
    for (let page = 1; page <= 100; page++) {
      check(); const query = params();
      for (const [key, value] of Object.entries({ dir, page: String(page), num: "100", order: "name", desc: "0", showempty: "1" })) query.set(key, value);
      const data = await request<{ errno: number; list?: CleanupEntry[]; has_more?: unknown }>("/api/list?" + query, { signal: controller.signal }, "json", 10_000);
      if (data.errno !== 0 || !Array.isArray(data.list)) throw new Error("无法确认目录清单，停止清理");
      // Identity lookup can finish at the matching page. Absence checks still exhaust every page.
      if (findPath) { const found = data.list.find(entry => entry.path === findPath); if (found) return [found]; }
      all.push(...data.list);
      if (data.has_more === false || data.has_more === 0 || (!data.has_more && data.list.length < 100)) return all;
    }
    throw new Error("目录分页未完成，停止清理");
  };
  const remove = async (entries: CleanupEntry[]) => {
    check(); const query = params(); query.set("opera", "delete"); query.set("async", "2"); query.set("onnest", "fail");
    const batch = { index: batches + 1, kind: entries.every(entry => Number(entry.isdir) === 1) ? "empty-directory" : "files", count: entries.length, bytes: entries.reduce((total, entry) => total + Number(entry.size ?? 0), 0), confirmedBatches: batches, ...(entries.length === 1 ? { filePath: entries[0].path } : {}) };
    const requestDelete = async () => {
    const result = await request<{ errno: number; taskid?: string | number; task_id?: string | number }>("/api/filemanager?" + query, {
      method: "POST", signal: controller.signal, headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ filelist: JSON.stringify(entries.map(entry => entry.path)) }),
    }, "json", 10_000);
    if (Number(result.errno) === 132) throw new Error("BAIDU_NETDISK_IDENTITY_VERIFICATION：网盘要求验证，停止所有后续删除");
    if (result.errno !== 0) throw new Error("删除失败，停止清理：errno=" + result.errno);
    const taskId = result.taskid ?? result.task_id;
    if (taskId != null) {
      if (!["number", "string"].includes(typeof taskId) || String(taskId) === "") throw new Error("删除任务ID不明，停止清理");
      for (let attempt = 0; ; attempt++) {
        check(); const p = params(); p.set("taskid", String(taskId));
        const state = await request<{ errno: number; status?: string; list?: Array<{ errno?: number; error_code?: number }> }>("/api/taskquery?" + p, { signal: controller.signal }, "json", 10_000);
        if (state.errno !== 0 || state.status === "failed" || state.list?.some(item => Number(item.errno ?? item.error_code ?? 0) !== 0)) throw new Error("删除任务失败，停止清理");
        if (state.status === "success") break;
        if (state.status !== "running" || attempt >= 19) throw new Error("删除结果未确认，停止清理");
        await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs ?? 1000));
      }
    }
    for (const dir of new Set(entries.map(entry => parent(entry.path)))) {
      const remaining = await list(dir);
      if (entries.some(entry => parent(entry.path) === dir && remaining.some(item => item.path === entry.path))) throw new Error("删除后文件仍然存在，停止清理，不重发请求");
    }
    batches++;
    };
    try { await requestDelete(); }
    catch (error) { throw new Error(`[BAIDU_CLEANUP_BATCH] ${JSON.stringify(batch)}\n${error instanceof Error ? error.message : String(error)}`); }
  };
  try {
    if (protect(root, Date.now(), []) || !/^\/[^/\\]+$/.test(root.path)) throw new Error("根目录受保护，拒绝删除");
    const ids = new Set<string>();
    for (const entry of options.entries) {
      if (!entry.path.startsWith(root.path + "/") || protect(entry, Date.now(), []) || ids.has(entry.path)) throw new Error("清理计划包含受保护或异常文件");
      ids.add(entry.path);
      if (Number(entry.isdir) !== 1 && (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > 2_000_000_000)) throw new Error("单个文件超过 2GB 或大小不明，拒绝自动删除");
    }
    const initial = (await list("/", root.path)).find(entry => entry.path === root.path);
    if (!initial || String(initial.fs_id) !== String(root.fs_id) || protect(initial, Date.now(), [])) throw new Error("根目录身份或日期已变化，拒绝清理");
    const files = options.entries.filter(entry => Number(entry.isdir) !== 1);
    while (files.length) {
      const batch: CleanupEntry[] = []; let batchBytes = 0;
      while (files.length && batch.length < (options.singleFile ? 1 : 20) && batchBytes + Number(files[0].size) <= 2_000_000_000) {
        const entry = files.shift()!; batch.push(entry); batchBytes += Number(entry.size);
      }
      // Fresh identity/date/size checks before every ordinary write.
      for (const dir of new Set(batch.map(entry => parent(entry.path)))) {
        const fresh = await list(dir);
        for (const entry of batch.filter(entry => parent(entry.path) === dir)) {
          const item = fresh.find(item => item.path === entry.path);
          if (!item || String(item.fs_id) !== String(entry.fs_id) || Number(item.isdir) !== 0 || item.size !== entry.size || protect(item, Date.now(), [])) throw new Error("文件身份、大小或日期已变化，停止清理");
        }
      }
      await remove(batch); bytes += batchBytes;
    }
    const directories = [root, ...options.entries.filter(entry => Number(entry.isdir) === 1)].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    for (const directory of directories) {
      // Parent mtime may now be today because of our deletes; never delete an unplanned child.
      const current = (await list(parent(directory.path), directory.path)).find(entry => entry.path === directory.path);
      if (!current || String(current.fs_id) !== String(directory.fs_id) || Number(current.isdir) !== 1 || Number(current.server_ctime) !== Number(directory.server_ctime)) throw new Error("目录身份已变化，停止清理");
      if ((await list(directory.path)).length) throw new Error("目录出现新文件或仍有文件，保留目录并暂停清理");
      await remove([{ ...directory, size: 0 }]);
    }
    return { deleted: true, batches, bytes };
  } finally { clearTimeout(timer); }
}
