/** Serialized into the official file renderer. Uses the client's normal network layer. */
export async function baiduOfficialCleanupRequest<T>(url: string, init: RequestInit = {}, format: "json" | "text" = "json", timeoutMs = 10_000, deleteFlow?: (path: string, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>): Promise<T> {
  const host = globalThis as unknown as {
    require?: (name: string) => { app?: { $Net?: (options: Record<string, unknown>) => Promise<{ data?: unknown; ajaxError?: unknown }> } };
    __dramaBridgeNativeCleanupNextWrite?: number;
    __dramaBridgeAutoCleanupContinue?: boolean;
    __dramaBridgeNativeCleanupFlowTimes?: number[];
  };
  const endpoint = new URL(url, "https://pan.baidu.com");
  const method = (init.method || "GET").toUpperCase();
  const write = endpoint.pathname === "/api/filemanager";
  if (endpoint.origin !== "https://pan.baidu.com" || format !== "json" || !["/api/list", "/api/quota", "/api/taskquery", "/api/filemanager"].includes(endpoint.pathname) || method !== (write ? "POST" : "GET")) throw new Error("拒绝非清理接口或未知请求方式");
  const app = host.require?.("@electron/remote").app;
  const net = app?.$Net;
  if (typeof net !== "function") throw new Error("官方网盘网络层不可用，清理已停止；不会改用分享页删除");
  const params: Record<string, string | number> = {};
  for (const key of ["dir", "page", "num", "order", "desc", "showempty", "taskid"]) {
    const value = endpoint.searchParams.get(key); if (value !== null) params[key] = value;
  }
  const options: Record<string, unknown> = { method: method.toLowerCase(), url: endpoint.origin + endpoint.pathname, params };
  let deletePath: string | undefined;
  if (write) {
    if (endpoint.searchParams.get("opera") !== "delete") throw new Error("拒绝非删除写入");
    const paths = JSON.parse(new URLSearchParams(String(init.body ?? "")).get("filelist") ?? "null");
    if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== "string" || paths[0] === "/" || !paths[0].startsWith("/") || /[\\\0]/.test(paths[0]) || paths[0].split("/").some((part: string) => part === "." || part === "..")) throw new Error("官方清理仅允许单个安全路径");
    if (typeof deleteFlow !== "function") throw new Error("客户端完整删除流程不可用，不降级为直接请求接口");
    deletePath = paths[0];
  }
  init.signal?.throwIfAborted();
  if (write && host.__dramaBridgeAutoCleanupContinue === false) throw new Error("自动清理已关闭，停止后续删除");
  if (write) {
    const wait = Math.max(0, (host.__dramaBridgeNativeCleanupNextWrite ?? 0) - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    init.signal?.throwIfAborted();
    if (host.__dramaBridgeAutoCleanupContinue === false) throw new Error("自动清理已关闭，停止后续删除");
    host.__dramaBridgeNativeCleanupNextWrite = Date.now() + 2000;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort(init.signal?.reason ?? new Error("清理已取消，请核对结果"));
  init.signal?.addEventListener("abort", cancel, { once: true });
  if (init.signal?.aborted) cancel();
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        if (write) {
          const now = Date.now();
          host.__dramaBridgeNativeCleanupFlowTimes = [...(host.__dramaBridgeNativeCleanupFlowTimes ?? []).filter(time => now - time < 60_000), now];
        }
        return write ? deleteFlow!(deletePath!, controller.signal, timeoutMs).then(data => ({ data })) : net.call(app, options);
      }),
      new Promise<never>((_, reject) => {
        const unknown = () => new Error("官方网盘请求结果未确认，请先核对后重试；不会自动重发删除");
        timer = setTimeout(() => controller.abort(unknown()), timeoutMs);
        abort = () => reject(controller.signal.reason ?? unknown());
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      }),
    ]);
    const data = result?.data as { errno?: unknown; request_id?: unknown; requestid?: unknown } | undefined;
    if (!data || typeof data !== "object") throw new Error("官方网盘返回无效响应，停止清理");
    if (Number(data.errno) === 132) {
      const requestId = String(data.request_id ?? data.requestid ?? "").replace(/[^\w-]/g, "").slice(0, 100);
      const times = host.__dramaBridgeNativeCleanupFlowTimes ?? [];
      const diagnostics = { at: new Date().toISOString(), flowAttemptsInLastMinute: times.filter(time => Date.now() - time < 60_000).length, ...(requestId ? { requestId } : {}) };
      throw new Error("[BAIDU_NETDISK_IDENTITY_VERIFICATION] 百度要求身份验证，停止后续删除；errno=132\n[BAIDU_CLEANUP_REQUEST] " + JSON.stringify(diagnostics));
    }
    if (result.ajaxError || data.errno !== 0) throw new Error("官方网盘操作失败，停止清理：errno=" + String(data.errno));
    return data as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
    if (abort) controller.signal.removeEventListener("abort", abort);
    if (write) host.__dramaBridgeNativeCleanupNextWrite = Date.now() + 2000;
  }
}
