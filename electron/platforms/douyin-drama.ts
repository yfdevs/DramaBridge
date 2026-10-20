import { app, ipcMain } from "electron";
import Store from "electron-store";
import { registerTaskAnalyticsHandler } from "./task-analytics";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  directoryDefaultPath,
  normalizePlatformRunDataDir,
  openExistingPath,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "./shared";
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from "./baidu-netdisk";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../global-app-config";
import { registerRuntimeAssetCleanupRoot } from "../runtime-asset-cleanup";

type DouyinDramaAccount = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};

type DouyinDramaAccountRuntimeStatus = {
  platform: "douyin-drama";
  running: boolean;
  loginState: "login-required" | "logged-in" | "unknown";
  activeUrl?: string;
  createUrl: string;
  loginUrl: string;
  userDataDir: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

type DouyinDramaAccountRuntime = {
  getStatus: () => DouyinDramaAccountRuntimeStatus;
  stop: () => Promise<void>;
};

type DouyinDramaRuntimeStatus = {
  platform: "douyin-drama";
  running: boolean;
  createUrl: string;
  loginUrl: string;
  accounts: Array<DouyinDramaAccountRuntimeStatus & DouyinDramaAccount & { launched: boolean }>;
};

type DouyinDramaRuntime = {
  getStatus: () => DouyinDramaRuntimeStatus;
  stop: () => Promise<void>;
};

export type DouyinDramaConfig = {
  apiBaseUrl: string;
  localEpisodeVideoRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
  episodeUploadReplaceAttempts: string;
  episodeUploadBatchSize: string;
  episodeUploadRetryAttempts?: string;
  episodeUploadWaitTimeoutMinutes: string;
  unitPriceYuan: string;
  paidEpisodeStart: string;
  headless: string;
  operationDelaySeconds: string;
  taskPollIntervalSeconds: string;
  runDataDir: string;
  logRetentionDays: string;
  closeFailedTaskPages: string;
};

type DouyinDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type DouyinDramaServiceStatus = DouyinDramaRuntimeStatus & { pid: number | null };
type DouyinDramaStore = { config: Partial<DouyinDramaConfig> };

const defaultConfig: DouyinDramaConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadReplaceAttempts: "5",
  episodeUploadBatchSize: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  unitPriceYuan: "0.5",
  paidEpisodeStart: "10",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: "D:\\.drama-runs\\douyin-drama",
  logRetentionDays: "3",
  closeFailedTaskPages: "false",
};

const runtimeController = new RuntimeController<DouyinDramaRuntime>();
let store: Store<DouyinDramaStore> | null = null;

function getStore() {
  store ??= new Store<DouyinDramaStore>({
    name: "douyin-drama-config",
    defaults: { config: defaultConfig },
  });
  return store;
}

function numberText(
  value: string | undefined,
  fallback: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
  integer = false,
) {
  const number = Number.parseFloat(value ?? "");
  return Number.isFinite(number)
      && number >= minimum
      && number <= maximum
      && (!integer || Number.isInteger(number))
    ? String(value).trim()
    : fallback;
}

function normalizeConfig(config: Partial<DouyinDramaConfig>): DouyinDramaConfig {
  return {
    apiBaseUrl: config.apiBaseUrl?.trim() || defaultConfig.apiBaseUrl,
    localEpisodeVideoRoot: config.localEpisodeVideoRoot?.trim() ?? "",
    baiduNetdiskDownloadRetryAttempts: numberText(
      config.baiduNetdiskDownloadRetryAttempts,
      defaultConfig.baiduNetdiskDownloadRetryAttempts,
      0,
    ),
    episodeUploadReplaceAttempts: numberText(
      config.episodeUploadReplaceAttempts ?? config.episodeUploadRetryAttempts,
      defaultConfig.episodeUploadReplaceAttempts,
      0,
      20,
      true,
    ),
    episodeUploadBatchSize: numberText(
      config.episodeUploadBatchSize,
      defaultConfig.episodeUploadBatchSize,
      1,
      50,
      true,
    ),
    episodeUploadWaitTimeoutMinutes: numberText(
      config.episodeUploadWaitTimeoutMinutes,
      defaultConfig.episodeUploadWaitTimeoutMinutes,
      1,
    ),
    unitPriceYuan: numberText(config.unitPriceYuan, defaultConfig.unitPriceYuan, 0.1, 9_999),
    paidEpisodeStart: numberText(
      config.paidEpisodeStart,
      defaultConfig.paidEpisodeStart,
      2,
      300,
      true,
    ),
    headless: config.headless === "true" ? "true" : "false",
    operationDelaySeconds: numberText(
      config.operationDelaySeconds,
      defaultConfig.operationDelaySeconds,
      0,
    ),
    taskPollIntervalSeconds: numberText(
      config.taskPollIntervalSeconds,
      defaultConfig.taskPollIntervalSeconds,
      1,
    ),
    runDataDir: config.runDataDir?.trim() || defaultConfig.runDataDir,
    logRetentionDays: numberText(config.logRetentionDays, defaultConfig.logRetentionDays, 1),
    closeFailedTaskPages: config.closeFailedTaskPages === "true" ? "true" : "false",
  };
}

function readConfig() {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("douyin-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function storagePaths(
  config = readConfig(),
  profile = "default",
): DouyinDramaStoragePaths {
  const runDataDir = resolveFromAppRoot(config.runDataDir);
  const accountDir = path.join(
    runDataDir,
    "auth",
    "accounts",
    encodeURIComponent(profile),
  );
  const logDir = path.join(runDataDir, "logs");
  const now = new Date();
  const dateKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return {
    runDataDir,
    accountDir,
    userDataDir: path.join(accountDir, "chromium-profile"),
    credentialStatePath: path.join(accountDir, "storage-state.json"),
    assetDownloadDir: path.join(runDataDir, "assets", encodeURIComponent(profile)),
    logDir,
    logFilePath: path.join(logDir, `app-${dateKey}.log`),
  };
}

function registerDouyinRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: "douyin-drama",
    rootPath: path.join(storagePaths(config).runDataDir, "assets"),
    maxDepth: 2,
    retentionMs: 3 * 60 * 60 * 1000,
  });
}

function ensureStorageDirectories(paths = storagePaths()) {
  for (const target of [
    paths.runDataDir,
    paths.accountDir,
    paths.userDataDir,
    paths.assetDownloadDir,
    paths.logDir,
  ]) {
    mkdirSync(target, { recursive: true });
  }
}

function defaultStoppedStatus(): DouyinDramaServiceStatus {
  return {
    platform: "douyin-drama",
    running: false,
    createUrl:
      "https://www.shortdramas.com/page/copyright/short-play/motion-comic-manage-edit-page/?from=book",
    loginUrl:
      "https://www.shortdramas.com/page/login?redirect=%2Fcopyright%2Fshort-play%2Fmotion-comic-manage-edit-page%2F%3Ffrom%3Dbook",
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<DouyinDramaServiceStatus> {
  const runtime = runtimeController.current;
  if (!runtime) return defaultStoppedStatus();
  const current = runtime.getStatus();
  if (!current.running) {
    await runtimeController.stop();
    return defaultStoppedStatus();
  }
  return { ...current, pid: process.pid };
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const configuredVideoRoot = config.localEpisodeVideoRoot.trim();
  if (!configuredVideoRoot) {
    throw new Error("请先在抖音短剧配置中选择剧集视频根目录，再启动服务。");
  }
  const localEpisodeVideoRoot = resolveFromAppRoot(configuredVideoRoot);
  if (!existsSync(localEpisodeVideoRoot) || !statSync(localEpisodeVideoRoot).isDirectory()) {
    throw new Error(`抖音短剧剧集视频根目录不存在或不是文件夹：${localEpisodeVideoRoot}`);
  }
  const {
    fetchDouyinDramaAccounts,
    startDouyinDramaRuntime,
  } = await import("@drama/douyin-drama-automation") as {
    fetchDouyinDramaAccounts: (apiBaseUrl: string) => Promise<DouyinDramaAccount[]>;
    startDouyinDramaRuntime: (options: Record<string, unknown>) => Promise<DouyinDramaAccountRuntime>;
  };
  const accounts = await fetchDouyinDramaAccounts(config.apiBaseUrl);
  if (accounts.length === 0) throw new Error("DOUYIN_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");

  const runtimes: Array<{ account: DouyinDramaAccount; runtime: DouyinDramaAccountRuntime }> = [];
  let running = true;
  try {
    for (const account of accounts) {
      const paths = storagePaths(config, account.accountId);
      ensureStorageDirectories(paths);
      const runtime = await startDouyinDramaRuntime({
        accountProfileName: account.accountId,
        douyinAccountId: account.accountId,
        douyinAccountName: account.accountName,
        apiConfig: { baseUrl: config.apiBaseUrl },
        closeFailedTaskPages: config.closeFailedTaskPages === "true",
        userDataDir: paths.userDataDir,
        credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir,
        logFilePath: paths.logFilePath,
        logRetentionDays: Number.parseInt(config.logRetentionDays, 10),
        localEpisodeVideoRoot,
        baiduNetdiskDownloadRetryAttempts: Number.parseInt(
          config.baiduNetdiskDownloadRetryAttempts,
          10,
        ),
        episodeUploadReplaceAttempts: Number.parseInt(config.episodeUploadReplaceAttempts, 10),
        episodeUploadBatchSize: Number.parseInt(config.episodeUploadBatchSize, 10),
        episodeUploadWaitTimeoutMinutes: Number.parseFloat(config.episodeUploadWaitTimeoutMinutes),
        unitPriceYuan: Number.parseFloat(config.unitPriceYuan),
        paidEpisodeStart: Number.parseInt(config.paidEpisodeStart, 10),
        taskPollIntervalMs: Number.parseFloat(config.taskPollIntervalSeconds) * 1_000,
        aiClientFactory: createConfiguredAiClient,
        aiImageModelFactory: getConfiguredAiImageModel,
        ensureBaiduNetdiskResource: (request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0]) => ensureBaiduNetdiskShareDownloaded({
          ...request,
          requesterPlatform: "douyin-drama",
        }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        config: {
          browser: {
            headless: config.headless === "true",
            slowMo: Number.parseFloat(config.operationDelaySeconds) * 1_000,
          },
        },
      });
      runtimes.push({ account, runtime });
    }
  } catch (error) {
    running = false;
    await Promise.allSettled(runtimes.map(({ runtime }) => runtime.stop()));
    throw error;
  }

  return {
    getStatus(): DouyinDramaRuntimeStatus {
      const runtimeAccounts = runtimes.map(({ account, runtime }) => {
        const current = runtime.getStatus();
        return { ...current, ...account, launched: current.running };
      });
      if (runtimeAccounts.every((account) => !account.launched)) running = false;
      return {
        platform: "douyin-drama",
        running,
        createUrl: defaultStoppedStatus().createUrl,
        loginUrl: defaultStoppedStatus().loginUrl,
        accounts: runtimeAccounts,
      };
    },
    async stop() {
      running = false;
      await Promise.allSettled(runtimes.map(({ runtime }) => runtime.stop()));
    },
  };
}

export function getDouyinDramaBrowserInstanceCount() {
  return runtimeController.current?.getStatus().accounts.filter((account) => account.launched).length ?? 0;
}

export function getDouyinDramaRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getDouyinDramaPlatformRuntimeSummary() {
  const runtime = runtimeController.current?.getStatus();
  const activeAccounts = runtime?.accounts.filter((account) => account.launched) ?? [];
  return {
    platform: "douyin-drama" as const,
    running: Boolean(runtime?.running),
    startedAt: runtimeController.startedAt,
    browserInstanceCount: activeAccounts.length,
    browserInstances: activeAccounts.map((account) => ({
      id: account.accountId,
      label: account.accountName,
      loginState: account.loginState,
      activeUrl: account.activeUrl,
    })),
    logDir: storagePaths().logDir,
  };
}

export function openDouyinDramaLogDir() {
  const paths = storagePaths();
  mkdirSync(paths.logDir, { recursive: true });
  return openExistingPath(paths.logDir);
}

export function registerDouyinDramaPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "douyin-drama",
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: "/dramaAiRpa/douyin",
  });
  registerDouyinRuntimeAssetCleanup();
  ipcMain.handle("douyin-drama:config:get", () => ({
    config: readConfig(),
    path: getStore().path,
    storagePaths: storagePaths(),
    restartRequired: false,
  }));
  ipcMain.handle("douyin-drama:config:save", (_event, config: DouyinDramaConfig) => {
    const nextConfig = normalizeConfig(config);
    getStore().set("config", nextConfig);
    registerDouyinRuntimeAssetCleanup(readConfig());
    return {
      config: nextConfig,
      path: getStore().path,
      storagePaths: storagePaths(nextConfig),
      restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
    };
  });
  ipcMain.handle("douyin-drama:config:select-run-data-dir", async (event, currentPath?: string) => {
    const selected = await selectDirectory(event, {
      title: "选择抖音短剧运行数据目录",
      defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
      properties: ["openDirectory", "createDirectory"],
    });
    return normalizePlatformRunDataDir(selected, "douyin-drama");
  });
  ipcMain.handle(
    "douyin-drama:config:select-local-episode-video-root",
    (event, currentPath?: string) => selectDirectory(event, {
      title: "选择抖音短剧剧集视频根目录",
      defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
      properties: ["openDirectory", "createDirectory"],
    }),
  );
  ipcMain.handle("douyin-drama:service:status", () => status());
  ipcMain.handle("douyin-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    await runtimeController.start(startRuntime);
    return status();
  });
  ipcMain.handle("douyin-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopDouyinDramaPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopDouyinDramaPlatformService() {
  return runtimeController.stop();
}
