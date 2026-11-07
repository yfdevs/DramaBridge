/** Serialized into the Baidu page. Keep this function independent of module scope. */
export async function baiduPageRequest<T>(
  url: string,
  init: RequestInit = {},
  format: "json" | "text" = "json",
  timeoutMs = 30_000,
): Promise<T> {
  const readOnly = /^(GET|HEAD)$/i.test(init.method || "GET");
  const attempts = readOnly ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("百度网盘请求已取消");
    try {
      const result = await requestOnce();
      const code = Number((result as any)?.errno ?? (result as any)?.error_code ?? 0);
      if (readOnly && [1, 4].includes(code) && attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 800));
        continue;
      }
      return result;
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      const message = String(error instanceof Error ? error.message : error);
      const retryable = /接口请求超时|Failed to fetch|fetch failed|NetworkError|network|HTTP (?:408|5\d\d)/i.test(message);
      if (!readOnly || !retryable || /BAIDU_NETDISK_(?:RISK|IDENTITY)/.test(message) || attempt === attempts) throw error;
      console.log(`[baidu-request] 读取失败，准备第${attempt + 1}/3次请求：${new URL(url, location.href).pathname}`);
      await new Promise(resolve => setTimeout(resolve, attempt * 800));
    }
  }
  throw new Error("百度网盘读取请求重试已用尽");

  async function requestOnce(): Promise<T> {
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
      // The official share client uses XHR. Keep the transfer on that transport
      // so the embedded client's request hooks see the same request as its UI.
      const response = endpoint === "/share/transfer" && typeof XMLHttpRequest !== "undefined"
        ? await new Promise<Response>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const cancel = () => xhr.abort();
            const cleanup = () => controller.signal.removeEventListener("abort", cancel);
            xhr.open(init.method || "GET", new URL(url, location.href).href, true);
            xhr.withCredentials = true;
            const headers = new Headers(init.headers);
            if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "XMLHttpRequest");
            headers.forEach((value, key) => xhr.setRequestHeader(key, value));
            xhr.onload = () => {
              cleanup();
              resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                url: xhr.responseURL,
                redirected: Boolean(xhr.responseURL && xhr.responseURL !== new URL(url, location.href).href),
                headers: {get: (name: string) => xhr.getResponseHeader(name)},
                text: async () => xhr.responseText,
                json: async () => JSON.parse(xhr.responseText),
              } as Response);
            };
            xhr.onerror = () => { cleanup(); reject(new Error("百度网盘转存网络请求失败，请核对目标目录后重试")); };
            xhr.onabort = () => { cleanup(); reject(new Error("转存请求已中止")); };
            controller.signal.addEventListener("abort", cancel, {once:true});
            if (controller.signal.aborted) { cleanup(); reject(new Error("转存请求已中止")); return; }
            xhr.send(init.body == null ? null : String(init.body));
          })
        : await fetch(url, { credentials: "include", ...init, signal: controller.signal });
      if (response.status === 429) {
        policy.blockedUntil = Date.now() + 60_000;
        throw new Error(`${riskMessage} HTTP 429 endpoint=${endpoint}`);
      }
      if (!response.ok) {
        // Do not expose signed URLs, credentials, or response HTML in logs.
        let finalPath = endpoint;
        try { finalPath = new URL(response.url || url, location.href).pathname; } catch {}
        const contentType = response.headers?.get?.("content-type") || "unknown";
        throw new Error(`百度网盘接口 HTTP ${response.status}：${endpoint}；method=${init.method || "GET"}；redirected=${Boolean(response.redirected)}；finalPath=${finalPath}；contentType=${contentType}`);
      }
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
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if (controller.signal.aborted) {
        throw new Error(`百度网盘接口请求超时（${timeoutMs / 1000} 秒）：${new URL(url, location.href).pathname}；请核对操作结果后重试。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
  }
}
