/** Serialized into the Baidu page. Keep this function independent of module scope. */
export async function baiduPageRequest<T>(
  url: string,
  init: RequestInit = {},
  format: "json" | "text" = "json",
  timeoutMs = 30_000,
): Promise<T> {
  // This function is serialized into the reusable share window. Keep state on
  // that window so all injected scans share pacing and a risk-control circuit.
  const host = globalThis as typeof globalThis & {
    __dramaBridgeRequestPolicy?: { nextStart: number; blockedUntil: number };
  };
  const policy = host.__dramaBridgeRequestPolicy ??= { nextStart: 0, blockedUntil: 0 };
  const endpoint = new URL(url, location.href).pathname;
  const riskMessage = "[BAIDU_NETDISK_RISK_CONTROL] 百度网盘要求验证或操作过于频繁，已暂停自动请求。请在客户端完成验证，稍后手动重试。";
  if (Date.now() < policy.blockedUntil) throw new Error(riskMessage);
  const start = Math.max(Date.now(), policy.nextStart);
  policy.nextStart = start + 400;
  if (start > Date.now()) await new Promise(resolve => setTimeout(resolve, start - Date.now()));
  if (Date.now() < policy.blockedUntil) throw new Error(riskMessage);
  const controller = new AbortController();
  const abort = controller.abort.bind(controller);
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "include", ...init, signal: controller.signal });
    if (response.status === 429) {
      policy.blockedUntil = Date.now() + 60_000;
      throw new Error(`${riskMessage} HTTP 429 endpoint=${endpoint}`);
    }
    if (!response.ok) throw new Error(`百度网盘接口 HTTP ${response.status}：${endpoint}`);
    // Reading the body must share the timeout: headers alone do not mean completion.
    const result = await (format === "text" ? response.text() : response.json());
    if (format === "json" && result && typeof result === "object") {
      const code = Number(result.errno ?? result.error_code ?? 0);
      if (code === 132) {
        const requestId = String(result.request_id ?? result.requestid ?? "").replace(/[^\w-]/g, "").slice(0, 100);
        throw new Error(`[BAIDU_NETDISK_IDENTITY_VERIFICATION] 百度网盘要求验证身份后才能删除或管理文件，请在客户端完成身份验证后重试此操作；不暂停其他上传。errno=${code} endpoint=${endpoint}${requestId ? ` request_id=${requestId}` : ""}`);
      }
      if ([8001, 8011, 80331, 80332, 80333, 8041, 8042, 8043, 8045, 8046, 8047, 8048, 8049, 8050, 8055, 8056, 8057, 110, 9002, 31034].includes(code)) {
        policy.blockedUntil = Date.now() + 60_000;
        const requestId = String(result.request_id ?? result.requestid ?? "").replace(/[^\w-]/g, "").slice(0, 100);
        throw new Error(`${riskMessage} errno=${code} endpoint=${endpoint}${requestId ? ` request_id=${requestId}` : ""}`);
      }
    }
    return result as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`百度网盘接口请求超时（${timeoutMs / 1000} 秒）：${new URL(url, location.href).pathname}；请核对操作结果后重试。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
