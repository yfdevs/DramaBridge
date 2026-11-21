/** Serialized into the file manager. Reuses the existing client flow, never confirms security dialogs. */
export async function deleteThroughOfficialClient(path: string, signal?: AbortSignal, timeoutMs = 10_000, expectedFsId?: string): Promise<{ errno: 0 }> {
  if (!path.startsWith("/") || path === "/" || /[\\\0]/.test(path) || path.split("/").some(part => part === "." || part === "..")) throw new Error("拒绝不安全的删除路径");
  if (/^\/(?:apps|文档加工|_pcs_\.workspace|_pcs_\.safebox)(?:\/|$)/i.test(path)) throw new Error("客户端保护目录不能自动删除");
  if (!expectedFsId || !/^[1-9]\d*$/.test(expectedFsId)) throw new Error("缺少已核对的文件身份，拒绝删除");
  const host = globalThis as unknown as { require?: (name: string) => any; __dramaBridgeOfficialDeleteBusy?: boolean; __dramaBridgeAutoCleanupContinue?: boolean };
  const isStopped = () => host.__dramaBridgeAutoCleanupContinue === false;
  if (host.__dramaBridgeOfficialDeleteBusy) throw new Error("客户端正在执行删除，请稍后再试");
  const remote = host.require?.("@electron/remote");
  if (typeof remote?.BrowserWindow?.getAllWindows !== "function") throw new Error("无法观察客户端验证窗口，拒绝自动删除");
  const securityOpen = () => remote.BrowserWindow.getAllWindows().some((window: any) => /#\/deleteFileSecurity(?:[/?]|$)/.test(String(window.webContents.getURL())));
  if (securityOpen()) throw new Error("[BAIDU_NETDISK_IDENTITY_VERIFICATION] 客户端已有身份验证窗口，请先完成验证");
  const queue = Array.from(document.querySelectorAll("*")).map(element => (element as any).__vue__).filter(Boolean);
  const seen = new Set<any>(); let vm: any;
  while (queue.length && seen.size < 2000) {
    const candidate = queue.shift(); if (seen.has(candidate)) continue;
    seen.add(candidate); queue.push(...(candidate.$children ?? []));
    if (candidate.$options?.name === "mainPage" && candidate.deletion && typeof candidate.deleteFile === "function" && typeof candidate.handleDelConfirm === "function") { vm = candidate; break; }
  }
  if (!vm) throw new Error("客户端原生删除流程不可用，不降级为直接请求接口");
  const state = vm.deletion;
  if (state.ifShowHintDialog || state.ifShowSkipFileDialog || state.confirmed || vm.progressToastTimer || vm.selectedFiles?.length || vm.$store?.state?.operateStatus?.isDeleteStatus) throw new Error("客户端有正在进行的操作，清理未接管该操作");
  signal?.throwIfAborted();
  if (isStopped()) throw new Error("自动清理已关闭");
  const encoded = encodeURIComponent(path);
  const ownsDialog = () => state.scheduledFiles?.length === 1 && state.scheduledFiles[0] === encoded;
  host.__dramaBridgeOfficialDeleteBusy = true;
  const deadline = Date.now() + timeoutMs;
  let confirmed = false, settled = false;
  let interval: ReturnType<typeof setInterval> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (vm.$route?.query?.path !== parent) {
      if (typeof vm.$router?.push !== "function") throw new Error("无法切换到文件所在目录，清理已暂停");
      let navigationTimer: ReturnType<typeof setTimeout> | undefined;
      let navigationAbort: (() => void) | undefined;
      try {
        await Promise.race([
          vm.$router.push({ path: "/", query: { category: "all", path: parent } }),
          new Promise<never>((_, reject) => {
            navigationTimer = setTimeout(() => reject(new Error("客户端目录切换未完成，清理已暂停")), Math.max(1, deadline - Date.now()));
            navigationAbort = () => reject(signal?.reason ?? new Error("清理已取消"));
            signal?.addEventListener("abort", navigationAbort, { once: true });
            if (signal?.aborted) navigationAbort();
          }),
        ]);
      } finally { clearTimeout(navigationTimer); if (navigationAbort) signal?.removeEventListener("abort", navigationAbort); }
    }
    const readyUntil = Math.min(deadline, Date.now() + 10_000);
    let file: any;
    while (Date.now() < readyUntil) {
      signal?.throwIfAborted();
      if (isStopped()) throw new Error("自动清理已关闭");
      if (vm.$route?.query?.path !== parent) throw new Error("客户端目录被切换，清理已暂停");
      file = vm.files?.find((entry: any) => entry.path === path);
      if (file) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!file || String(file.fs_id) !== expectedFsId) throw new Error("客户端文件身份已变化或未加载完成，拒绝删除");
    if (Number(file.isdir) === 0) {
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const start = Date.parse(today + "T00:00:00+08:00");
      const times = [file.server_ctime, file.server_mtime].map(value => { const n = Number(value); return n > 0 && Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN; });
      if (times.some(time => !Number.isFinite(time) || time >= start) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 2_000_000_000) throw new Error("客户端文件日期或大小已变化，保留文件");
    }
    if (Number(file.knowledge_type ?? 0) > 0 || path.startsWith("/_pcs_.safebox/")) throw new Error("该文件需要额外保护确认，清理已暂停");
    if (state.ifShowHintDialog || state.ifShowSkipFileDialog || vm.selectedFiles?.length) throw new Error("客户端操作状态已变化，清理已暂停");
    return await new Promise<{ errno: 0 }>((resolve, reject) => {
      const finish = (error?: unknown) => {
        if (settled) return; settled = true;
        if (error) reject(error); else resolve({ errno: 0 });
      };
      const tick = () => {
        if (settled) return;
        try {
          signal?.throwIfAborted();
          if (isStopped()) throw new Error("自动清理已关闭，停止后续操作");
          if (securityOpen()) throw new Error("[BAIDU_NETDISK_IDENTITY_VERIFICATION] 百度打开身份验证窗口，清理已暂停");
          if (!ownsDialog()) throw new Error("客户端待删列表已变化，停止清理");
          if (confirmed) return;
          if (state.ifShowSkipFileDialog) throw new Error("客户端需要额外共享文件确认，清理已暂停");
          if (!state.ifShowHintDialog) return;
          // CONFIRM_DEL=1. Shared/knowledge/safebox scenes and failed prechecks are never accepted.
          if (state.scene !== 1 || state.delSharedFiles !== true || (state.skipFiles?.length ?? 0) !== 0) throw new Error("客户端前置检查需要人工确认，清理已暂停");
          confirmed = true;
          vm.handleDelConfirm();
        } catch (error) { finish(error); }
      };
      abort = () => finish(signal?.reason ?? new Error("清理已取消，请核对删除结果"));
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => finish(new Error("客户端删除结果未确认，已停止；不会自动重发")), Math.max(1, deadline - Date.now()));
      interval = setInterval(tick, 200);
      try {
        Promise.resolve(vm.deleteFile([encoded], (success: boolean) => finish(success ? undefined : new Error("客户端未确认删除成功，请核对后重试")))).catch(finish);
      } catch (error) { finish(error); }
    });
  } finally {
    clearInterval(interval); clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
    // Only cancel our unconfirmed ordinary dialog; never close or accept an identity dialog.
    if (!confirmed && ownsDialog() && state.ifShowHintDialog && state.scene === 1) {
      try { vm.handleDelCancel(); } catch { /* Preserve the original failure. */ }
    }
    host.__dramaBridgeOfficialDeleteBusy = false;
  }
}
