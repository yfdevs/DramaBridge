import type { TaobaoDramaApiConfig } from "../shared/types.js";

export type TaobaoDramaHttpClient = {
  post: <T>(path: string, payload: unknown) => Promise<T>;
};

export function createTaobaoDramaHttpClient(config: TaobaoDramaApiConfig): TaobaoDramaHttpClient {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("TAOBAO_DRAMA_API_BASE_URL_REQUIRED");
  return {
    async post<T>(requestPath: string, payload: unknown): Promise<T> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
      try {
        const response = await fetch(`${baseUrl}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`, {
          method: "POST",
          headers: { accept: "application/json, text/plain, */*", "content-type": "application/json;charset=UTF-8" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`TAOBAO_DRAMA_API_REQUEST_FAILED: path=${requestPath} status=${response.status}`);
        return await response.json() as T;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
