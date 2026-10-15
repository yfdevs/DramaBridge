import {
  createOpenAiCompatibleClient,
  type OpenAiCompatibleClient,
  type OpenAiCompatibleClientOptions,
} from "@drama/ai";
import {
  app,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import Store from "electron-store";
import path from "node:path";
import sharp from "sharp";

import { directoryDefaultPath, selectDirectory } from "./platforms/shared";

const ARK_API_KEY_URL = "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey";
const LEGACY_DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
const RECOMMENDED_AI_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const RECOMMENDED_AI_MODEL = "doubao-seed-2-0-pro-260215";
const RECOMMENDED_AI_IMAGE_MODEL = "doubao-seedream-4-0-250828";
const DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES = "60";
const DEFAULT_AI_COVER_GENERATION_RETRY_ATTEMPTS = "3";
const DEFAULT_JIANYING_EPISODE_COUNT = "4";
const MAX_AI_COVER_GENERATION_RETRY_ATTEMPTS = 10;
const MAX_JIANYING_EPISODE_COUNT = 100;
export const GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE = "GLOBAL_APP_DIRECTORIES_REQUIRED";

export type GlobalAppConfig = {
  aiApiKey: string;
  aiBaseURL: string;
  aiModel: string;
  aiImageModel: string;
  aiCoverGenerationRetryAttempts: string;
  aiPosterFallbackEnabled: boolean;
  baiduNetdiskDownloadTimeoutMinutes: string;
  baiduNetdiskCleanupPlayletAfterTaskSuccess: boolean;
  jianyingEpisodeCount: string;
  runDataRoot: string;
  localMaterialRoot: string;
};

type StoredGlobalAppConfig = {
  aiApiKeyCiphertext: string;
  aiBaseURL: string;
  aiModel: string;
  aiImageModel: string;
  aiCoverGenerationRetryAttempts?: string;
  aiPosterFallbackEnabled?: boolean;
  baiduNetdiskDownloadTimeoutMinutes?: string;
  baiduNetdiskCleanupPlayletAfterTaskSuccess?: boolean;
  jianyingEpisodeCount?: string;
  runDataRoot?: string;
  localMaterialRoot?: string;
};

type GlobalAppConfigStore = {
  config: StoredGlobalAppConfig;
};

const defaultStoredConfig: StoredGlobalAppConfig = {
  aiApiKeyCiphertext: "",
  aiBaseURL: RECOMMENDED_AI_BASE_URL,
  aiModel: RECOMMENDED_AI_MODEL,
  aiImageModel: RECOMMENDED_AI_IMAGE_MODEL,
  aiCoverGenerationRetryAttempts: DEFAULT_AI_COVER_GENERATION_RETRY_ATTEMPTS,
  aiPosterFallbackEnabled: true,
  baiduNetdiskDownloadTimeoutMinutes: DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
  baiduNetdiskCleanupPlayletAfterTaskSuccess: false,
  jianyingEpisodeCount: DEFAULT_JIANYING_EPISODE_COUNT,
  runDataRoot: "",
  localMaterialRoot: "",
};

let registered = false;
let store: Store<GlobalAppConfigStore> | null = null;

function getStore() {
  store ??= new Store<GlobalAppConfigStore>({
    name: "global-app-config",
    defaults: { config: defaultStoredConfig },
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
  return String(
    Math.min(MAX_AI_COVER_GENERATION_RETRY_ATTEMPTS, Math.max(0, Math.floor(parsed))),
  );
}

function normalizeJianyingEpisodeCount(value: string | undefined) {
  const parsed = Number(value?.trim());
  if (!Number.isFinite(parsed)) return DEFAULT_JIANYING_EPISODE_COUNT;
  return String(Math.min(MAX_JIANYING_EPISODE_COUNT, Math.max(1, Math.floor(parsed))));
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

function normalizeGlobalAppConfig(config: Partial<GlobalAppConfig>): GlobalAppConfig {
  return {
    aiApiKey: config.aiApiKey?.trim() ?? "",
    aiBaseURL: normalizeBaseURL(config.aiBaseURL),
    aiModel: config.aiModel?.trim() ?? "",
    aiImageModel: config.aiImageModel?.trim() || RECOMMENDED_AI_IMAGE_MODEL,
    aiCoverGenerationRetryAttempts: normalizeAiCoverGenerationRetryAttempts(
      config.aiCoverGenerationRetryAttempts,
    ),
    aiPosterFallbackEnabled: normalizeBoolean(config.aiPosterFallbackEnabled, true),
    baiduNetdiskDownloadTimeoutMinutes: normalizePositiveNumberText(
      config.baiduNetdiskDownloadTimeoutMinutes,
      DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
    ),
    baiduNetdiskCleanupPlayletAfterTaskSuccess: normalizeBoolean(
      config.baiduNetdiskCleanupPlayletAfterTaskSuccess,
      false,
    ),
    jianyingEpisodeCount: normalizeJianyingEpisodeCount(config.jianyingEpisodeCount),
    runDataRoot: config.runDataRoot?.trim() ?? "",
    localMaterialRoot: config.localMaterialRoot?.trim() ?? "",
  };
}

export function readGlobalAppConfig(): GlobalAppConfig {
  let config = getStore().get("config");
  if (
    !config.aiApiKeyCiphertext
    && !config.aiModel.trim()
    && config.aiBaseURL === LEGACY_DEFAULT_AI_BASE_URL
  ) {
    config = defaultStoredConfig;
    getStore().set("config", config);
  }

  return {
    aiApiKey: decryptApiKey(config.aiApiKeyCiphertext),
    aiBaseURL: normalizeBaseURL(config.aiBaseURL),
    aiModel: config.aiModel.trim(),
    aiImageModel: config.aiImageModel?.trim() || RECOMMENDED_AI_IMAGE_MODEL,
    aiCoverGenerationRetryAttempts: normalizeAiCoverGenerationRetryAttempts(
      config.aiCoverGenerationRetryAttempts,
    ),
    aiPosterFallbackEnabled: normalizeBoolean(config.aiPosterFallbackEnabled, true),
    baiduNetdiskDownloadTimeoutMinutes: normalizePositiveNumberText(
      config.baiduNetdiskDownloadTimeoutMinutes,
      DEFAULT_BAIDU_NETDISK_DOWNLOAD_TIMEOUT_MINUTES,
    ),
    baiduNetdiskCleanupPlayletAfterTaskSuccess: normalizeBoolean(
      config.baiduNetdiskCleanupPlayletAfterTaskSuccess,
      false,
    ),
    jianyingEpisodeCount: normalizeJianyingEpisodeCount(config.jianyingEpisodeCount),
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

export function isAiPosterFallbackEnabled() {
  return normalizeBoolean(getStore().get("config").aiPosterFallbackEnabled, true);
}

export function isBaiduNetdiskPlayletCleanupEnabled() {
  return normalizeBoolean(
    getStore().get("config").baiduNetdiskCleanupPlayletAfterTaskSuccess,
    false,
  );
}

export function getConfiguredJianyingEpisodeCount() {
  return Number.parseInt(
    normalizeJianyingEpisodeCount(getStore().get("config").jianyingEpisodeCount),
    10,
  );
}

function saveGlobalAppConfig(config: Partial<GlobalAppConfig>) {
  const normalized = normalizeGlobalAppConfig(config);

  getStore().set("config", {
    aiApiKeyCiphertext: encryptApiKey(normalized.aiApiKey),
    aiBaseURL: normalized.aiBaseURL,
    aiModel: normalized.aiModel,
    aiImageModel: normalized.aiImageModel,
    aiCoverGenerationRetryAttempts: normalized.aiCoverGenerationRetryAttempts,
    aiPosterFallbackEnabled: normalized.aiPosterFallbackEnabled,
    baiduNetdiskDownloadTimeoutMinutes: normalized.baiduNetdiskDownloadTimeoutMinutes,
    baiduNetdiskCleanupPlayletAfterTaskSuccess:
      normalized.baiduNetdiskCleanupPlayletAfterTaskSuccess,
    jianyingEpisodeCount: normalized.jianyingEpisodeCount,
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
    runDataDir: runDataRoot
      ? path.join(runDataRoot, platformDirectoryName)
      : fallback.runDataDir,
    localMaterialRoot: localMaterialRoot || fallback.localMaterialRoot,
  };
}

export function assertGlobalDirectoriesConfigured() {
  const config = getStore().get("config");
  const missingDirectories = [
    !config.runDataRoot?.trim() ? "运行数据根目录" : null,
    !config.localMaterialRoot?.trim() ? "素材根目录" : null,
  ].filter((label): label is string => Boolean(label));

  if (missingDirectories.length > 0) {
    throw new Error(
      `${GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE}: 请先在“全局配置 → 文件与目录”中设置${missingDirectories.join("、")}。`,
    );
  }
}

async function selectGlobalDirectory(
  event: IpcMainInvokeEvent,
  key: "runDataRoot" | "localMaterialRoot",
  currentPath?: string,
) {
  return selectDirectory(event, {
    title: key === "runDataRoot" ? "选择全局运行数据根目录" : "选择全局素材根目录",
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
  }).png().toBuffer();
  const startedAt = Date.now();
  const result = await client.analyzeImages({
    images: [{ dataUrl: `data:image/png;base64,${testImage.toString("base64")}`, type: "data-url" }],
    maxTokens: 16,
    prompt: "这是图片与文本能力连接测试。确认能读取图片后，只回复 OK。",
  });

  return {
    latencyMs: Date.now() - startedAt,
    model: result.model,
    responseText: result.text.replace(/\s+/g, " ").slice(0, 80),
  };
}

export function registerGlobalAppConfigHandlers(options: {
  getRunningPlatformCount?: () => number;
} = {}) {
  if (registered) return;
  registered = true;

  ipcMain.handle("app:config:get", () => configResult());
  ipcMain.handle("app:config:save", (_event, config: Partial<GlobalAppConfig>) => {
    const previous = readGlobalAppConfig();
    const saved = saveGlobalAppConfig(config);
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
