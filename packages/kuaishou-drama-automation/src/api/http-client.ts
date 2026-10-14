import type { KuaishouDramaApiConfig } from "../shared/types.js";

export type KuaishouDramaHttpClient = {
  get?: <T>(path: string) => Promise<T>;
  post: <T>(path: string, payload: unknown) => Promise<T>;
};

export function createKuaishouDramaHttpClient(
  config: KuaishouDramaApiConfig,
): KuaishouDramaHttpClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30_000;

  return {
    async get<T>(path: string): Promise<T> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
          method: "GET",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as T;
      } finally {
        clearTimeout(timeout);
      }
    },
    async post<T>(path: string, payload: unknown): Promise<T> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as T;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
