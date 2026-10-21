export type AppTheme = "system" | "light" | "dark";

export type GlobalAppConfig = {
  theme: AppTheme;
  aiApiKey: string;
  aiBaseURL: string;
  aiModel: string;
  aiImageModel: string;
  aiCoverGenerationRetryAttempts: string;
  aiPosterFallbackEnabled: boolean;
  baiduNetdiskDownloadTimeoutMinutes: string;
  baiduNetdiskCleanupPlayletAfterTaskSuccess: boolean;
  runDataRoot: string;
  localMaterialRoot: string;
};

export type GlobalAppConfigResult = {
  config: GlobalAppConfig;
  path: string;
  restartRequired: boolean;
};

export type AiConfigTestResult = {
  latencyMs: number;
  model: string;
  responseText: string;
};

async function invokeGlobalAppConfig<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("全局配置仅在 Electron 应用内可用。");

  try {
    return (await window.ipcRenderer.invoke(channel, ...args)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("APP_CONFIG_ENCRYPTION_UNAVAILABLE")) {
      if (error instanceof Error) {
        error.message = "当前系统无法安全加密 API Key，请确认系统凭据服务可用后重试。";
      }
      throw error;
    }
    if (message.includes("APP_CONFIG_API_KEY_DECRYPT_FAILED")) {
      if (error instanceof Error) {
        error.message = "已保存的 API Key 无法解密，请重新填写并保存。";
      }
      throw error;
    }
    if (message.includes("AI_BASE_URL_INVALID")) {
      if (error instanceof Error) {
        error.message = "API Base URL 必须是有效的 HTTP 或 HTTPS 地址。";
      }
      throw error;
    }
    if (message.includes("DRAMA_AI_API_KEY_REQUIRED")) {
      if (error instanceof Error) error.message = "请填写 API Key 后再测试。";
      throw error;
    }
    if (message.includes("DRAMA_AI_MODEL_REQUIRED")) {
      if (error instanceof Error) error.message = "请填写模型 ID 后再测试。";
      throw error;
    }
    throw error;
  }
}

export function onAppThemeChanged(listener: (theme: AppTheme) => void) {
  if (!window.ipcRenderer) return () => undefined;
  const handler = (_event: unknown, theme: AppTheme) => listener(theme);
  window.ipcRenderer.on("app:theme:changed", handler);
  return () => {
    window.ipcRenderer.off("app:theme:changed", handler);
  };
}

export const globalAppConfigService = {
  getTheme: () => invokeGlobalAppConfig<AppTheme>("app:theme:get"),
  getConfig: () => invokeGlobalAppConfig<GlobalAppConfigResult>("app:config:get"),
  saveConfig: (config: GlobalAppConfig) =>
    invokeGlobalAppConfig<GlobalAppConfigResult>("app:config:save", config),
  testConfig: (config: GlobalAppConfig) =>
    invokeGlobalAppConfig<AiConfigTestResult>("app:config:test", config),
  openArkApiKeyPage: () => invokeGlobalAppConfig<void>("app:config:open-ark-api-key-page"),
  selectDirectory: (key: "runDataRoot" | "localMaterialRoot", currentPath?: string) =>
    invokeGlobalAppConfig<string | null>("app:config:select-directory", key, currentPath),
};
