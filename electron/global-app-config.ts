import {
  createOpenAiCompatibleClient,
  type OpenAiCompatibleClient,
  type OpenAiCompatibleClientOptions,
} from "@dramabridge/ai";
import {
  app,
  nativeTheme,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import Store from "electron-store";
import path from "node:path";
import sharp from "sharp";

import { WindowsOwnershipOcr } from "./local-ownership-ocr";

import { createValidatedStore } from "./core/config-store";
import { emitIpcEvent, trpcIpc as ipcMain } from "./ipc";
import { directoryDefaultPath, selectDirectory } from "./platforms/shared";

const ARK_API_KEY_URL = "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey";
const LEGACY_DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
const RECOMMENDED_AI_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const RECOMMENDED_AI_MODEL = "doubao-seed-2-0-pro-260215";
const RECOMMENDED_AI_IMAGE_MODEL = "doubao-seedream-4-0-250828";
const DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES = "60";
const DEFAULT_AI_COVER_GENERATION_RETRY_ATTEMPTS = "3";
const MAX_AI_COVER_GENERATION_RETRY_ATTEMPTS = 10;
export const GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE = "GLOBAL_APP_DIRECTORIES_REQUIRED";

export type GlobalAppConfig = {
  theme: "system" | "light" | "dark";
  aiApiKey: string;
  aiBaseURL: string;
  aiModel: string;
  aiImageModel: string;
  aiCoverGenerationRetryAttempts: string;
  aiPosterFallbackEnabled: boolean;
  ownershipLocalOcrEnabled: boolean;
  baiduNetdiskDownloadTimeoutMinutes: string;
  baiduNetdiskCleanupPlayletAfterTaskSuccess: boolean;
  runDataRoot: string;
  localMaterialRoot: string;
};

type StoredGlobalAppConfig = {
  theme?: GlobalAppConfig["theme"];
  aiApiKeyCiphertext: string;
  aiBaseURL: string;
  aiModel: string;
  aiImageModel: string;
  aiCoverGenerationRetryAttempts?: string;
  aiPosterFallbackEnabled?: boolean;
  ownershipLocalOcrEnabled?: boolean;
  baiduNetdiskDownloadTimeoutMinutes?: string;
  baiduNetdiskCleanupPlayletAfterTaskSuccess?: boolean;
  runDataRoot?: string;
  localMaterialRoot?: string;
};

type GlobalAppConfigStore = {
  config: StoredGlobalAppConfig;
  externalApi: { enabled: boolean; port: string };
};

export type ExternalApiConfig = { enabled: boolean; port: string };
export type ExternalApiStatus = { running: boolean; baseUrl?: string; error?: string };
const defaultExternalApi = { enabled: false, port: "18439" };

export function readExternalApiConfig(): ExternalApiConfig {
  const stored = getStore().get("externalApi") ?? defaultExternalApi;
  return { enabled: stored.enabled === true, port: stored.port || "18439" };
}

const defaultStoredConfig: StoredGlobalAppConfig = {
  theme: "system",
  aiApiKeyCiphertext: "",
  aiBaseURL: RECOMMENDED_AI_BASE_URL,
  aiModel: RECOMMENDED_AI_MODEL,
  aiImageModel: RECOMMENDED_AI_IMAGE_MODEL,
  aiCoverGenerationRetryAttempts: DEFAULT_AI_COVER_GENERATION_RETRY_ATTEMPTS,
  aiPosterFallbackEnabled: true,
  ownershipLocalOcrEnabled: false,
  baiduNetdiskDownloadTimeoutMinutes: DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
  baiduNetdiskCleanupPlayletAfterTaskSuccess: false,
  runDataRoot: "",
  localMaterialRoot: "",
};

let registered = false;
let store: Store<GlobalAppConfigStore> | null = null;

function getStore() {
  store ??= createValidatedStore<GlobalAppConfigStore>({
    name: "global-app-config",
    defaults: { config: defaultStoredConfig, externalApi: defaultExternalApi },
  });
  return store;
}

function normalizeBaseURL(value: string | undefined) {
  const normalized = value?.trim() || RECOMMENDED_AI_BASE_URL;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("AI_BASE_URL_INVALID");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI_BASE_URL_INVALID");
  }

  return normalized.replace(/\/+$/, "");
}

function normalizePositiveNumberText(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) && number > 0 ? normalized : fallback;
}

function normalizeAiCoverGenerationRetryAttempts(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_AI_COVER_GENERATION_RETRY_ATTEMPTS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return DEFAULT_AI_COVER_GENERATION_RETRY_ATTEMPTS;
  return String(Math.min(MAX_AI_COVER_GENERATION_RETRY_ATTEMPTS, Math.max(0, Math.floor(parsed))));
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function encryptApiKey(apiKey: string) {
  if (!apiKey) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("APP_CONFIG_ENCRYPTION_UNAVAILABLE");
  }

  return safeStorage.encryptString(apiKey).toString("base64");
}

function decryptApiKey(ciphertext: string) {
  if (!ciphertext) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("APP_CONFIG_ENCRYPTION_UNAVAILABLE");
  }

  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  } catch {
    throw new Error("APP_CONFIG_API_KEY_DECRYPT_FAILED");
  }
}

function normalizeTheme(theme: unknown): GlobalAppConfig["theme"] {
  return theme === "light" || theme === "dark" ? theme : "system";
}

function applyAppTheme(theme: GlobalAppConfig["theme"]) {
  nativeTheme.themeSource = theme;
  emitIpcEvent("app:theme:changed", theme);
}

function normalizeGlobalAppConfig(config: Partial<GlobalAppConfig>): GlobalAppConfig {
  return {
    theme: normalizeTheme(config.theme),
    aiApiKey: config.aiApiKey?.trim() ?? "",
    aiBaseURL: normalizeBaseURL(config.aiBaseURL),
    aiModel: config.aiModel?.trim() ?? "",
    aiImageModel: config.aiImageModel?.trim() || RECOMMENDED_AI_IMAGE_MODEL,
    aiCoverGenerationRetryAttempts: normalizeAiCoverGenerationRetryAttempts(
      config.aiCoverGenerationRetryAttempts,
    ),
    aiPosterFallbackEnabled: normalizeBoolean(config.aiPosterFallbackEnabled, true),
    ownershipLocalOcrEnabled: normalizeBoolean(config.ownershipLocalOcrEnabled, false),
    baiduNetdiskDownloadTimeoutMinutes: normalizePositiveNumberText(
      config.baiduNetdiskDownloadTimeoutMinutes,
      DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
    ),
    baiduNetdiskCleanupPlayletAfterTaskSuccess: normalizeBoolean(
      config.baiduNetdiskCleanupPlayletAfterTaskSuccess,
      false,
    ),
    runDataRoot: config.runDataRoot?.trim() ?? "",
    localMaterialRoot: config.localMaterialRoot?.trim() ?? "",
  };
}

export function readGlobalAppConfig(): GlobalAppConfig {
  let config = getStore().get("config");
  if (
    !config.aiApiKeyCiphertext &&
    !config.aiModel.trim() &&
    config.aiBaseURL === LEGACY_DEFAULT_AI_BASE_URL
  ) {
    config = defaultStoredConfig;
    getStore().set("config", config);
  }

  return {
    theme: normalizeTheme(config.theme),
    aiApiKey: decryptApiKey(config.aiApiKeyCiphertext),
    aiBaseURL: normalizeBaseURL(config.aiBaseURL),
    aiModel: config.aiModel.trim(),
    aiImageModel: config.aiImageModel?.trim() || RECOMMENDED_AI_IMAGE_MODEL,
    aiCoverGenerationRetryAttempts: normalizeAiCoverGenerationRetryAttempts(
      config.aiCoverGenerationRetryAttempts,
    ),
    aiPosterFallbackEnabled: normalizeBoolean(config.aiPosterFallbackEnabled, true),
    ownershipLocalOcrEnabled: normalizeBoolean(config.ownershipLocalOcrEnabled, false),
    baiduNetdiskDownloadTimeoutMinutes: normalizePositiveNumberText(
      config.baiduNetdiskDownloadTimeoutMinutes,
      DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
    ),
    baiduNetdiskCleanupPlayletAfterTaskSuccess: normalizeBoolean(
      config.baiduNetdiskCleanupPlayletAfterTaskSuccess,
      false,
    ),
    runDataRoot: config.runDataRoot?.trim() ?? "",
    localMaterialRoot: config.localMaterialRoot?.trim() ?? "",
  };
}

export function getConfiguredBaiduNetdiskDownloadTimeoutMs() {
  const value = normalizePositiveNumberText(
    getStore().get("config").baiduNetdiskDownloadTimeoutMinutes,
    DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
  );
  return Number.parseFloat(value) * 60 * 1000;
}

const ownershipOcr = new WindowsOwnershipOcr();

export const classifyConfiguredOwnershipLocally = (file: string) =>
  getStore().get("config").ownershipLocalOcrEnabled === true
    ? ownershipOcr.classify(file)
    : Promise.resolve("unknown" as const);

export const stopLocalOwnershipOcr = () => ownershipOcr.stop();

export function isAiPosterFallbackEnabled() {
  return normalizeBoolean(getStore().get("config").aiPosterFallbackEnabled, true);
}

export function isBaiduNetdiskPlayletCleanupEnabled() {
  return normalizeBoolean(
    getStore().get("config").baiduNetdiskCleanupPlayletAfterTaskSuccess,
    false,
  );
}

function saveGlobalAppConfig(config: Partial<GlobalAppConfig>) {
  const normalized = normalizeGlobalAppConfig(config);

  getStore().set("config", {
    theme: normalized.theme,
    aiApiKeyCiphertext: encryptApiKey(normalized.aiApiKey),
    aiBaseURL: normalized.aiBaseURL,
    aiModel: normalized.aiModel,
    aiImageModel: normalized.aiImageModel,
    aiCoverGenerationRetryAttempts: normalized.aiCoverGenerationRetryAttempts,
    aiPosterFallbackEnabled: normalized.aiPosterFallbackEnabled,
    ownershipLocalOcrEnabled: normalized.ownershipLocalOcrEnabled,
    baiduNetdiskDownloadTimeoutMinutes: normalized.baiduNetdiskDownloadTimeoutMinutes,
    baiduNetdiskCleanupPlayletAfterTaskSuccess:
      normalized.baiduNetdiskCleanupPlayletAfterTaskSuccess,
    runDataRoot: normalized.runDataRoot,
    localMaterialRoot: normalized.localMaterialRoot,
  });

  return normalized;
}

function configResult(config = readGlobalAppConfig(), restartRequired = false) {
  return {
    config,
    path: getStore().path,
    restartRequired,
  };
}

export function resolveGlobalPlatformDirectories(
  platformDirectoryName: string,
  fallback: { runDataDir: string; localMaterialRoot: string },
) {
  const config = getStore().get("config");
  const runDataRoot = config.runDataRoot?.trim();
  const localMaterialRoot = config.localMaterialRoot?.trim();

  return {
    runDataDir: runDataRoot ? path.join(runDataRoot, platformDirectoryName) : fallback.runDataDir,
    localMaterialRoot: localMaterialRoot || fallback.localMaterialRoot,
  };
}

export function assertGlobalDirectoriesConfigured() {
  const config = getStore().get("config");
  const missingDirectories = [
    !config.runDataRoot?.trim() ? "运行数据目录" : null,
    !config.localMaterialRoot?.trim() ? "素材目录" : null,
  ].filter((label): label is string => Boolean(label));

  if (missingDirectories.length > 0) {
    throw new Error(
      `${GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE}: 请先在“全局配置 → 文件存储”中设置${missingDirectories.join("、")}。`,
    );
  }
}

async function selectGlobalDirectory(
  event: IpcMainInvokeEvent,
  key: "runDataRoot" | "localMaterialRoot",
  currentPath?: string,
) {
  return selectDirectory(event, {
    title: key === "runDataRoot" ? "选择运行数据目录" : "选择素材目录",
    defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
    properties: ["openDirectory", "createDirectory"],
  });
}

function aiClientOptions(config: GlobalAppConfig): OpenAiCompatibleClientOptions {
  if (!config.aiApiKey) throw new Error("DRAMA_AI_API_KEY_REQUIRED");
  if (!config.aiModel) throw new Error("DRAMA_AI_MODEL_REQUIRED");

  return {
    apiKey: config.aiApiKey,
    baseURL: config.aiBaseURL,
    model: config.aiModel,
  };
}

export function getConfiguredAiClientOptions(): OpenAiCompatibleClientOptions {
  return aiClientOptions(readGlobalAppConfig());
}

export function createConfiguredAiClient(): OpenAiCompatibleClient {
  return createOpenAiCompatibleClient(getConfiguredAiClientOptions());
}

export function getConfiguredAiImageModel() {
  const model = readGlobalAppConfig().aiImageModel.trim();
  if (!model) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");
  return model;
}

export function getConfiguredAiCoverGenerationRetryAttempts() {
  return Number.parseInt(
    normalizeAiCoverGenerationRetryAttempts(
      getStore().get("config").aiCoverGenerationRetryAttempts,
    ),
    10,
  );
}

async function testAiConfig(config: Partial<GlobalAppConfig>) {
  const client = createOpenAiCompatibleClient(aiClientOptions(normalizeGlobalAppConfig(config)));
  const testImage = await sharp({
    create: {
      background: { alpha: 1, b: 70, g: 35, r: 220 },
      channels: 4,
      height: 64,
      width: 64,
    },
  })
    .png()
    .toBuffer();
  const startedAt = Date.now();
  const result = await client.analyzeImages({
    images: [
      { dataUrl: `data:image/png;base64,${testImage.toString("base64")}`, type: "data-url" },
    ],
    maxTokens: 16,
    prompt: "这是图片与文本能力连接测试。确认能读取图片后，只回复 OK。",
  });

  return {
    latencyMs: Date.now() - startedAt,
    model: result.model,
    responseText: result.text.replace(/\s+/g, " ").slice(0, 80),
  };
}

export function registerGlobalAppConfigHandlers(
  options: {
    getRunningPlatformCount?: () => number;
    configureExternalApi?: (config: ExternalApiConfig) => Promise<void>;
    getExternalApiStatus?: () => ExternalApiStatus;
  } = {},
) {
  if (registered) return;
  registered = true;

  applyAppTheme(normalizeTheme(getStore().get("config").theme));
  ipcMain.handle("app:theme:get", () => normalizeTheme(getStore().get("config").theme));

  ipcMain.handle("app:config:get", () => configResult());
  ipcMain.handle("app:config:local-ocr:test", () => ownershipOcr.test());
  const externalApiResult = () => ({ config: readExternalApiConfig(),
    status: options.getExternalApiStatus?.() ?? { running: false } });
  let externalApiSave: Promise<unknown> = Promise.resolve();
  ipcMain.handle("app:config:external-api:get", externalApiResult);
  ipcMain.handle("app:config:external-api:status", () => options.getExternalApiStatus?.() ?? { running: false });
  ipcMain.handle("app:config:external-api:save", (_event, value: ExternalApiConfig) => {
    const save = externalApiSave.catch(() => undefined).then(async () => {
      if (!value || typeof value.enabled !== "boolean" || typeof value.port !== "string") {
        throw new Error("本机接口配置格式错误");
      }
      const port = Number(value.port);
      if (!/^\d+$/u.test(value.port) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("本机接口端口必须是 1～65535 的整数");
      }
      if (!options.configureExternalApi) throw new Error("本机接口服务尚未初始化");
      await options.configureExternalApi({ enabled: value.enabled, port: String(port) });
      getStore().set("externalApi", { enabled: value.enabled, port: String(port) });
      return externalApiResult();
    });
    externalApiSave = save;
    return save;
  });
  ipcMain.handle("app:config:save", (_event, config: Partial<GlobalAppConfig>) => {
    const previous = readGlobalAppConfig();
    const saved = saveGlobalAppConfig(config);
    if (previous.theme !== saved.theme) applyAppTheme(saved.theme);
    const directoryChanged =
      previous.runDataRoot !== saved.runDataRoot ||
      previous.localMaterialRoot !== saved.localMaterialRoot;
    const runtimeConfigChanged =
      directoryChanged ||
      previous.aiCoverGenerationRetryAttempts !== saved.aiCoverGenerationRetryAttempts;
    return configResult(
      saved,
      runtimeConfigChanged && (options.getRunningPlatformCount?.() ?? 0) > 0,
    );
  });
  ipcMain.handle("app:config:test", (_event, config: Partial<GlobalAppConfig>) => {
    return testAiConfig(config);
  });
  ipcMain.handle("app:config:open-ark-api-key-page", () => shell.openExternal(ARK_API_KEY_URL));
  ipcMain.handle(
    "app:config:select-directory",
    (event, key: "runDataRoot" | "localMaterialRoot", currentPath?: string) => {
      if (key !== "runDataRoot" && key !== "localMaterialRoot") {
        throw new Error("APP_CONFIG_DIRECTORY_KEY_INVALID");
      }
      return selectGlobalDirectory(event, key, currentPath);
    },
  );
}
