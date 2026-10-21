import { app } from "electron";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import { registerTaskAnalyticsHandler } from "../shared/task-analytics";
import path from "node:path";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";
import { createElectronPlatformLogger } from "../../platform-logger";
import { registerRuntimeAssetCleanupRoot } from "../../runtime-asset-cleanup";
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from "../baidu-netdisk";
import {
  directoryDefaultPath,
  ensureDirectories as ensureDirectoryPaths,
  findLatestFile,
  normalizePlatformRunDataDir,
  openExistingPath,
  openPathOrParent,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "../shared";

type Account = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
};

type AccountStatus = {
  platform: "tencent-huolong-drama";
  running: boolean;
  loginState: "login-required" | "logged-in" | "unknown";
  activeUrl?: string;
  addUrl: string;
  loginUrl: string;
  userDataDir: string;
  accountDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle?: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

type PlatformRuntime = {
  getStatus: () => PlatformStatus;
  stop: () => Promise<void>;
};

type AccountRuntime = { getStatus: () => AccountStatus; stop: () => Promise<void> };

type PlatformStatus = {
  platform: "tencent-huolong-drama";
  running: boolean;
  addUrl: string;
  loginUrl: string;
  accounts: Array<AccountStatus & Account & { launched: boolean }>;
};

export type TencentHuolongDramaConfig = {
  accountProfileName: string;
  apiBaseUrl: string;
  localMaterialRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
  episodeUploadWaitTimeoutMinutes: string;
  episodeUploadFailedRetryAttempts: string;
  headless: string;
  operationDelaySeconds: string;
  taskPollIntervalSeconds: string;
  closeFailedTaskPages: string;
  runDataDir: string;
  logRetentionDays: string;
};

type StoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type TencentHuolongDramaServiceStatus = PlatformStatus & { pid: number | null };

const defaults: TencentHuolongDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localMaterialRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  episodeUploadFailedRetryAttempts: "3",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  closeFailedTaskPages: "false",
  runDataDir: "D:\\.drama-runs\\tencent-huolong-drama",
  logRetentionDays: "3",
};

const controller = new RuntimeController<PlatformRuntime>();
let store: Store<{ config: TencentHuolongDramaConfig }> | null = null;

function configStore(): Store<{ config: TencentHuolongDramaConfig }> {
  if (!store) {
    store = createValidatedStore<{ config: TencentHuolongDramaConfig }>({
      name: "tencent-huolong-drama-config",
      defaults: { config: defaults },
    });
  }
  return store;
}

function numberText(value: string | undefined, fallback: string, minimum = 0) {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed >= minimum ? value.trim() : fallback;
}

function normalizeConfig(config: Partial<TencentHuolongDramaConfig>): TencentHuolongDramaConfig {
  return {
    accountProfileName: config.accountProfileName?.trim() || defaults.accountProfileName,
    apiBaseUrl: config.apiBaseUrl?.trim() || defaults.apiBaseUrl,
    localMaterialRoot: config.localMaterialRoot ?? defaults.localMaterialRoot,
    baiduNetdiskDownloadRetryAttempts: numberText(config.baiduNetdiskDownloadRetryAttempts, "3"),
    episodeUploadWaitTimeoutMinutes: numberText(config.episodeUploadWaitTimeoutMinutes, "120", 1),
    episodeUploadFailedRetryAttempts: numberText(config.episodeUploadFailedRetryAttempts, "3"),
    headless: config.headless ?? defaults.headless,
    operationDelaySeconds: numberText(config.operationDelaySeconds, "0"),
    taskPollIntervalSeconds: numberText(config.taskPollIntervalSeconds, "10", 1),
    closeFailedTaskPages: config.closeFailedTaskPages ?? defaults.closeFailedTaskPages,
    runDataDir: config.runDataDir?.trim() || defaults.runDataDir,
    logRetentionDays: numberText(config.logRetentionDays, "3", 1),
  };
}

function readConfig() {
  const config = normalizeConfig(configStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("tencent-huolong-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localMaterialRoot,
  });
  return { ...config, ...directories };
}

function runDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function storagePaths(config = readConfig(), accountId = config.accountProfileName): StoragePaths {
  const encoded = encodeURIComponent(accountId.trim() || "default");
  const accountDir = path.join(runDataDir(config), "auth", "accounts", encoded);
  const logDir = path.join(runDataDir(config), "logs");
  return {
    runDataDir: runDataDir(config),
    accountDir,
    userDataDir: path.join(accountDir, "chromium-profile"),
    credentialStatePath: path.join(accountDir, "storage-state.json"),
    assetDownloadDir: path.join(runDataDir(config), "assets", encoded),
    logDir,
    logFilePath: path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`),
  };
}

function ensureDirectories(paths: StoragePaths) {
  ensureDirectoryPaths([paths.runDataDir, paths.accountDir, paths.userDataDir, paths.assetDownloadDir, paths.logDir]);
}

function latestLog(paths = storagePaths()) {
  return findLatestFile(paths.logDir, (fileName) => /\.(?:log|jsonl)$/i.test(fileName));
}

function platformLogger() {
  const config = readConfig();
  return createElectronPlatformLogger({
    platform: "tencent-huolong-drama",
    scope: "runtime",
    logDir: path.join(runDataDir(config), "logs"),
    retentionDays: Number(config.logRetentionDays) || 3,
  });
}

async function importRuntimePackage() {
  return import("@dramabridge/tencent-huolong-drama-automation") as Promise<{
    fetchTencentHuolongDramaAccounts: (baseUrl: string) => Promise<Account[]>;
    startTencentHuolongDramaRuntime: (options: Record<string, unknown>) => Promise<AccountRuntime>;
  }>;
}

function stoppedStatus(): TencentHuolongDramaServiceStatus {
  return {
    platform: "tencent-huolong-drama",
    running: false,
    addUrl: "https://mp.v.qq.com/kairos/album/create",
    loginUrl: "https://mp.v.qq.com/",
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<TencentHuolongDramaServiceStatus> {
  const runtime = controller.current;
  if (!runtime) return stoppedStatus();
  const current = runtime.getStatus();
  if (!current.running) {
    await controller.stop();
    return stoppedStatus();
  }
  return { ...current, pid: process.pid };
}

async function startRuntime(): Promise<PlatformRuntime> {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const { fetchTencentHuolongDramaAccounts, startTencentHuolongDramaRuntime } = await importRuntimePackage();
  const accounts = await fetchTencentHuolongDramaAccounts(config.apiBaseUrl);
  if (accounts.length === 0) throw new Error("TENCENT_HUOLONG_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");
  const aiClient = createConfiguredAiClient();
  const aiImageModel = getConfiguredAiImageModel();
  const runtimes: Array<{ account: Account; runtime: AccountRuntime }> = [];
  let running = true;
  try {
    for (const account of accounts) {
      const paths = storagePaths(config, account.accountId);
      ensureDirectories(paths);
      const runtime = await startTencentHuolongDramaRuntime({
        accountProfileName: account.accountId,
        accountId: account.accountId,
        accountName: account.accountName,
        accountDir: paths.accountDir,
        userDataDir: paths.userDataDir,
        credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir,
        logFilePath: paths.logFilePath,
        logRetentionDays: Number(config.logRetentionDays) || 3,
        localMaterialRoot: config.localMaterialRoot,
        baiduNetdiskDownloadRetryAttempts: Number(config.baiduNetdiskDownloadRetryAttempts) || 0,
        episodeUploadWaitTimeoutMinutes: Number(config.episodeUploadWaitTimeoutMinutes) || 120,
        episodeUploadFailedRetryAttempts: Number(config.episodeUploadFailedRetryAttempts) || 0,
        taskPollIntervalMs: (Number(config.taskPollIntervalSeconds) || 10) * 1_000,
        closeFailedTaskPages: config.closeFailedTaskPages === "true",
        aiClient,
        aiImageModel,
        aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        ensureBaiduNetdiskResource: (request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0]) =>
          ensureBaiduNetdiskShareDownloaded({ ...request, requesterPlatform: "tencent-huolong-drama" }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        apiConfig: { baseUrl: config.apiBaseUrl },
        config: {
          browser: {
            headless: config.headless === "true",
            slowMo: (Number(config.operationDelaySeconds) || 0) * 1_000,
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
    getStatus() {
      const runtimeAccounts = runtimes.map(({ account, runtime }) => ({
        ...runtime.getStatus(),
        ...account,
        launched: runtime.getStatus().running,
      }));
      if (runtimeAccounts.every((account) => !account.launched)) running = false;
      return {
        platform: "tencent-huolong-drama",
        running,
        addUrl: "https://mp.v.qq.com/kairos/album/create",
        loginUrl: "https://mp.v.qq.com/",
        accounts: runtimeAccounts,
      };
    },
    async stop() {
      running = false;
      await Promise.allSettled(runtimes.map(({ runtime }) => runtime.stop()));
    },
  };
}

export function getTencentHuolongDramaBrowserInstanceCount() {
  return controller.current?.getStatus().accounts.filter((account) => account.launched).length ?? 0;
}

export function getTencentHuolongDramaRunningPlatformCount() {
  return controller.current?.getStatus().running ? 1 : 0;
}

export function getTencentHuolongDramaPlatformRuntimeSummary() {
  const current = controller.current?.getStatus();
  const paths = storagePaths();
  return {
    platform: "tencent-huolong-drama" as const,
    running: Boolean(current?.running),
    startedAt: controller.startedAt,
    browserInstanceCount: current?.accounts.filter((account) => account.launched).length ?? 0,
    browserInstances: current?.accounts.filter((account) => account.launched).map((account) => ({
      id: account.accountId,
      label: account.accountName,
      loginState: account.loginState,
      activeUrl: account.activeUrl,
    })) ?? [],
    logDir: paths.logDir,
  };
}

export function openTencentHuolongDramaLogDir() {
  const paths = storagePaths();
  ensureDirectories(paths);
  return openExistingPath(paths.logDir);
}

export function registerTencentHuolongDramaPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "tencent-huolong-drama",
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: "/dramaAiRpa/tencent",
  });
  registerRuntimeAssetCleanupRoot({
    platform: "tencent-huolong-drama",
    rootPath: path.join(storagePaths().runDataDir, "assets"),
    maxDepth: 2,
    retentionMs: 3 * 60 * 60 * 1_000,
  });
  ipcMain.handle("tencent-huolong-drama:config:get", () => ({
    config: readConfig(), path: configStore().path, storagePaths: storagePaths(), restartRequired: false,
  }));
  ipcMain.handle("tencent-huolong-drama:config:save", (_event, value: TencentHuolongDramaConfig) => {
    const config = normalizeConfig(value);
    configStore().set("config", config);
    return {
      config,
      path: configStore().path,
      storagePaths: storagePaths(config),
      restartRequired: controller.running || controller.startingPromise !== null,
    };
  });
  ipcMain.handle("tencent-huolong-drama:config:select-run-data-dir", async (event, current?: string) => {
    const selected = await selectDirectory(event, {
      title: "选择腾讯火龙漫剧运行数据目录",
      defaultPath: directoryDefaultPath(current, app.getPath("documents")),
      properties: ["openDirectory", "createDirectory"],
    });
    return normalizePlatformRunDataDir(selected, "tencent-huolong-drama");
  });
  ipcMain.handle("tencent-huolong-drama:config:select-local-material-root", (event, current?: string) =>
    selectDirectory(event, {
      title: "选择腾讯火龙漫剧本地素材目录",
      defaultPath: directoryDefaultPath(current, app.getPath("pictures")),
      properties: ["openDirectory", "createDirectory"],
    }));
  ipcMain.handle("tencent-huolong-drama:config:open-storage-path", (_event, key: keyof StoragePaths | "configFilePath" | "latestLog") => {
    const paths = storagePaths();
    ensureDirectories(paths);
    if (key === "configFilePath") return openPathOrParent(configStore().path);
    if (key === "latestLog") return openExistingPath(latestLog(paths));
    if (key === "credentialStatePath" || key === "logFilePath") return openPathOrParent(paths[key]);
    return openExistingPath(paths[key]);
  });
  ipcMain.handle("tencent-huolong-drama:service:status", () => status());
  ipcMain.handle("tencent-huolong-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    await controller.start(startRuntime);
    platformLogger().info("Tencent Huolong drama service started");
    return status();
  });
  ipcMain.handle("tencent-huolong-drama:service:stop", async () => {
    await controller.stop();
    return status();
  });
}

export function stopTencentHuolongDramaPlatformRuntime() {
  controller.stopInBackground();
}

export function stopTencentHuolongDramaPlatformService() {
  return controller.stop();
}
