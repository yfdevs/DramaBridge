/** Serialized into the Baidu page. Keep this function independent of module scope. */
export async function baiduPageRequest<T>(
  url: string,
  init: RequestInit = {},
  format: "json" | "text" = "json",
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "include", ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`百度网盘接口 HTTP ${response.status}：${new URL(url, location.href).pathname}`);
    // Reading the body must share the timeout: headers alone do not mean completion.
    return await (format === "text" ? response.text() : response.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`百度网盘接口请求超时（${timeoutMs / 1000} 秒）：${new URL(url, location.href).pathname}；请核对操作结果后重试。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
