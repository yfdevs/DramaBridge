import { ApiClient, AxiosError } from "@dramabridge/axios";
import { getWechatMiniProgramRuntimeSettings } from "../shared/runtime-settings.js";

export const httpClient = new ApiClient({
  timeout: 30000,
});

httpClient.addRequestInterceptor((config) => {
  const apiBaseUrl = getWechatMiniProgramRuntimeSettings().apiBaseUrl.trim();
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
      const responseData = error.response.data;
      const message = typeof responseData === "object" && responseData !== null
        ? JSON.stringify(responseData)
        : typeof responseData === "string" || typeof responseData === "number"
          ? String(responseData)
          : error.message;
      throw new Error(`${method} ${url} failed: HTTP ${error.response.status} ${message}`);
    }

    throw new Error(`${method} ${url} failed: ${error.message}`);
  },
);
