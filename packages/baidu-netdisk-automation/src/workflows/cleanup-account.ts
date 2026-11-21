import { getTargets, withPage } from "../infrastructure/cdp.js";
import { baiduPageRequest } from "../infrastructure/page-request.js";
import { baiduOfficialCleanupRequest } from "../infrastructure/official-cleanup-request.js";
import { isBaiduFileRenderer, isBaiduMainFileTarget } from "../infrastructure/main-file-target.js";
import { deleteThroughOfficialClient } from "./official-delete-flow.js";
import { baiduCleanupProtection } from "./cleanup-policy.js";
import { deleteBaiduCleanupTreeInPage } from "./delete-cleanup-tree.js";

export type CleanupDirectory = { path: string; fs_id: string | number; isdir: number; server_ctime: number; server_mtime: number };
export type NetdiskQuota = { used: number; total: number };
export type CleanupEntry = CleanupDirectory & { size?: number };

/** Serialized into an already connected account page; never navigates it. */
export async function inspectBaiduCleanupInPage(
  request: <T>(url: string, init?: RequestInit, format?: "json" | "text", timeout?: number) => Promise<T>,
  protect: typeof baiduCleanupProtection,
  options: { action: "quota" | "roots" | "inspect"; root?: CleanupDirectory; protectedPaths?: string[]; now: number },
): Promise<{ quota?: NetdiskQuota; roots?: CleanupDirectory[]; reason?: string; files?: number; entries?: CleanupEntry[]; scannedAt?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const locals = (globalThis as unknown as { locals?: { get?: (key: string) => unknown }; yunData?: { bdstoken?: string } });
  const token = String(locals.locals?.get?.("bdstoken") || locals.yunData?.bdstoken || "");
  const params = () => new URLSearchParams({ channel: "chunlei", web: "1", app_id: "250528", clienttype: "0", bdstoken: token });
  try {
    if (options.action === "quota") {
      const data = await request<{ errno: number; used: number; total: number }>("/api/quota?" + params(), { signal: controller.signal }, "json", 10_000);
      if (data.errno !== 0 || !Number.isSafeInteger(data.used) || data.used < 0 || !Number.isSafeInteger(data.total) || data.total <= 0) throw new Error("无法确认网盘容量，已停止自动清理");
      return { quota: { used: data.used, total: data.total } };
    }
    let reads = 0;
    const list = async (dir: string) => {
      const entries: Record<string, unknown>[] = [];
      for (let page = 1; page <= 1000; page++) {
        if (++reads > 100) throw new Error("目录扫描未完成，保留该目录");
        controller.signal.throwIfAborted();
        const query = params();
        for (const [key, value] of Object.entries({ dir, page: String(page), num: "100", order: "name", desc: "0", showempty: "1" })) query.set(key, value);
        const data = await request<{ errno: number; list?: Record<string, unknown>[]; has_more?: unknown }>("/api/list?" + query, { signal: controller.signal }, "json", 10_000);
        if (data.errno !== 0 || !Array.isArray(data.list)) throw new Error("目录读取失败，无法安全清理");
        entries.push(...data.list);
        if (data.has_more === false || data.has_more === 0 || (!data.has_more && data.list.length < 100)) return entries;
      }
      throw new Error("目录分页未完成，无法安全清理");
    };
    const roots = await list("/");
    if (options.action === "roots") return { roots: roots.filter(entry => Number(entry.isdir) === 1) as CleanupDirectory[] };
    const root = options.root!;
    const current = roots.find(entry => entry.path === root.path);
    if (!current || String(current.fs_id) !== String(root.fs_id) || Number(current.isdir) !== 1) return { reason: "目录身份已变化" };
    const queue = [current];
    const seen = new Set<string>();
    let files = 0;
    const entries: CleanupEntry[] = [];
    while (queue.length) {
      // Overlap at most two independent directory reads. The shared request
      // policy still paces starts; deletes are never parallelized.
      const directories = queue.splice(0, 2);
      for (const directory of directories) {
        const path = String(directory.path);
        if (seen.has(path)) return { reason: "目录结构异常" };
        seen.add(path);
        const reason = protect(directory, options.now, options.protectedPaths ?? []);
        if (reason) return { reason };
      }
      const results = await Promise.allSettled(directories.map(directory => list(String(directory.path))));
      // Settle every launched read before returning, including failure paths.
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === "rejected") throw result.reason;
        const path = String(directories[index].path);
        for (const entry of result.value) {
          const child = String(entry.path ?? "");
          if (!child.startsWith(path + "/")) return { reason: "子目录路径异常" };
          const protectedReason = protect(entry, options.now, options.protectedPaths ?? []);
          if (protectedReason) return { reason: protectedReason };
          if (Number(entry.isdir) !== 1 && (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0)) return { reason: "文件大小不明，保留该目录" };
          if (Number(entry.isdir) !== 1 && Number(entry.size) > 2_000_000_000) return { reason: "包含超过 2GB 的单个文件，保留该目录" };
          entries.push({ path: child, fs_id: entry.fs_id as string | number, isdir: Number(entry.isdir), server_ctime: Number(entry.server_ctime), server_mtime: Number(entry.server_mtime), size: Number(entry.size ?? 0) });
          if (Number(entry.isdir) === 1) queue.push(entry);
          else files++;
        }
      }
    }
    return { files, entries, scannedAt: options.now };
  } catch (error) {
    if (options.action === "inspect" && (controller.signal.aborted || String(error).includes("目录扫描未完成"))) return { reason: "扫描未完成，保留该目录" };
    throw error;
  } finally { clearTimeout(timer); }
}

async function cleanupPage<T>(port: number, action: (page: import("../infrastructure/cdp.js").CdpPage) => Promise<T>) {
  const target = (await getTargets(port)).find(item => item.webSocketDebuggerUrl && /^https:\/\/pan\.baidu\.com\//.test(item.url));
  if (!target) throw new Error("请先连接并登录百度网盘客户端");
  return withPage(target, action);
}

export async function readBaiduCleanup(port: number, action: "quota" | "roots" | "inspect", root?: CleanupDirectory, protectedPaths: string[] = []) {
  return cleanupPage(port, page => page.evaluate<Awaited<ReturnType<typeof inspectBaiduCleanupInPage>>>(`(${inspectBaiduCleanupInPage.toString()})(${baiduPageRequest.toString()},${baiduCleanupProtection.toString()},${JSON.stringify({ action, root, protectedPaths, now: Date.now() })})`, 50_000));
}

export async function deleteBaiduCleanupDirectory(port: number, root: CleanupDirectory, shouldContinue: () => boolean = () => true, inspection?: { entries: CleanupEntry[]; scannedAt: number }) {
  if (!/^\/[^/\\]+$/.test(root.path) || root.path === "/.." || root.path === "/.") throw new Error("拒绝删除非根目录下的独立目录");
  const targets = await getTargets(port);
  let native: typeof targets[number] | undefined;
  for (const candidate of targets.filter(isBaiduFileRenderer)) {
    const role = await withPage(candidate, page => page.evaluate<{ windowId?: number; mainWindowId?: number }>("(()=>{const r=globalThis.require?.('@electron/remote');return {windowId:r?.getCurrentWindow()?.id,mainWindowId:r?.app?.mainBrowserwindow?.id};})()")).catch(() => null);
    if (role && isBaiduMainFileTarget({ ...candidate, ...role })) { native = candidate; break; }
  }
  if (!native) throw new Error("官方网盘文件管理窗口不可用，清理已停止；不会改用分享页删除");
  return withPage(native, async page => {
    if (!shouldContinue()) throw new Error("自动清理已关闭");
    await page.evaluate("globalThis.__dramaBridgeAutoCleanupContinue=true");
    const timer = setInterval(() => {
      if (!shouldContinue()) void page.evaluate("globalThis.__dramaBridgeAutoCleanupContinue=false").catch(() => undefined);
    }, 500);
    try {
      // Reuse only a fresh, same-day scan from the current exclusive operation.
      // The tree deleter still rechecks root identity and every selected file before writing.
      const now = Date.now();
      const day = (time: number) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
      const reusable = inspection && Number.isFinite(inspection.scannedAt) && inspection.scannedAt <= now && now - inspection.scannedAt <= 60_000 && day(inspection.scannedAt) === day(now) ? inspection : undefined;
      return await page.evaluate(`(async()=>{const nativeRequest=${baiduOfficialCleanupRequest.toString()};const clientFlow=${deleteThroughOfficialClient.toString()};let ids;const nativeDelete=(path,signal,timeout)=>clientFlow(path,signal,timeout,ids?.get(path));const request=(url,init,format,timeout)=>nativeRequest(url,init,format,init?.method==='POST'?Math.max(timeout||10000,30000):timeout,nativeDelete);const protect=${baiduCleanupProtection.toString()};const root=${JSON.stringify(root)};const inspection=${reusable ? JSON.stringify(reusable) : `await (${inspectBaiduCleanupInPage.toString()})(request,protect,{action:'inspect',root,now:Date.now()})`};if(inspection.reason)throw new Error(inspection.reason);ids=new Map([root,...inspection.entries].map(entry=>[entry.path,String(entry.fs_id)]));return (${deleteBaiduCleanupTreeInPage.toString()})(request,protect,{root,entries:inspection.entries,singleFile:true});})()`, 960_000);
    } finally { clearInterval(timer); await page.evaluate("globalThis.__dramaBridgeAutoCleanupContinue=false").catch(() => undefined); }
  });
}
