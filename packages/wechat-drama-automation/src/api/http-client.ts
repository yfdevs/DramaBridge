import { ApiClient, AxiosError } from "@dramabridge/axios";
import { getWechatVideoRuntimeSettings } from "../shared/runtime-settings.js";

export const httpClient = new ApiClient({
  timeout: 30000,
});

httpClient.addRequestInterceptor((config) => {
  const apiBaseUrl = getWechatVideoRuntimeSettings().apiBaseUrl.trim();
  if (!config.baseURL && !apiBaseUrl) {
    throw new Error("apiBaseUrl is required.");
  }
  config.baseURL = config.baseURL ?? apiBaseUrl;

  return config;
});

httpClient.addResponseInterceptor(
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
