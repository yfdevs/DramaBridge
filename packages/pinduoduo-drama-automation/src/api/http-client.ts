import { ApiClient, AxiosError } from "@dramabridge/axios";
import { pinduoduoDramaApiConfigSchema, type PinduoduoDramaApiConfig } from "../shared/types.js";

export interface PinduoduoDramaHttpClient {
  post<T = unknown, D = unknown>(url: string, data?: D): Promise<T>;
}

export function createPinduoduoDramaHttpClient(config: PinduoduoDramaApiConfig): PinduoduoDramaHttpClient {
  const parsedConfig = pinduoduoDramaApiConfigSchema.parse(config);
  const client = new ApiClient({
    baseURL: parsedConfig.apiBaseUrl,
    timeout: parsedConfig.timeoutMs,
    headers: parsedConfig.headers,
  });

  client.addResponseInterceptor(
    (response) => response,
    (error: AxiosError) => {
      const method = error.config?.method?.toUpperCase() ?? "REQUEST";
      const url = error.config?.url ?? "";

      if (error.response) {
        const message = typeof error.response.data === "object" && error.response.data !== null
          ? JSON.stringify(error.response.data)
          : String(error.response.data ?? error.message);
        throw new Error(`${method} ${url} failed: HTTP ${error.response.status} ${message}`);
      }

      throw new Error(`${method} ${url} failed: ${error.message}`);
    },
  );

  return client;
}
