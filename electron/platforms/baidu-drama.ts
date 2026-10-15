import { app, ipcMain } from "electron";
import Store from "electron-store";
import { registerTaskAnalyticsHandler } from "./task-analytics";
import cron, { type ScheduledTask } from "node-cron";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
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
import { createElectronPlatformLogger } from "../platform-logger";
import { registerRuntimeAssetCleanupRoot } from "../runtime-asset-cleanup";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../global-app-config";

type BaiduDramaAccount = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};

type BaiduDramaAccountRuntimeStatus = {
  platform: "baidu-drama";
  running: boolean;
  loginState: "login-required" | "logged-in" | "unknown";
  activeUrl?: string;
  createUrl: string;
  loginUrl: string;
  userDataDir: string;
  taskClaimResumeAt?: number;
  lastTask?: {
    accountTaskId: number;
    originalTitle: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

type BaiduDramaAccountRuntime = {
  getStatus: () => BaiduDramaAccountRuntimeStatus;
  stop: () => Promise<void>;
};

type BaiduDramaRuntimeStatus = {
  platform: "baidu-drama";
  running: boolean;
  createUrl: string;
  loginUrl: string;
  accounts: Array<BaiduDramaAccountRuntimeStatus & {
    accountId: string;
    accountName: string;
    loginAccount?: string | null;
    launched: boolean;
  }>;
};

type BaiduDramaRuntime = {
  getStatus: () => BaiduDramaRuntimeStatus;
  stop: () => Promise<void>;
};

export type BaiduDramaConfig = {
  apiBaseUrl: string;
  localEpisodeVideoRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
  episodeUploadWaitTimeoutMinutes: string;
  headless: string;
  operationDelaySeconds: string;
  taskPollIntervalSeconds: string;
  runDataDir: string;
  logRetentionDays: string;
};

type BaiduDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type BaiduDramaServiceStatus = BaiduDramaRuntimeStatus & { pid: number | null };
type BaiduDramaStore = {
  config: Partial<BaiduDramaConfig>;
  taskClaimResumeAtByAccount?: Record<string, number>;
};

const defaultConfig: BaiduDramaConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: "D:\\.drama-runs\\baidu-drama",
  logRetentionDays: "3",
};

const runtimeController = new RuntimeController<BaiduDramaRuntime>();
const baiduAiCoverTemporaryFilePattern = /^\.generated-(?:landscape|portrait)-\d+-\d+\.image$/;
const baiduAiCoverTemporaryFileRetentionMs = 24 * 60 * 60 * 1_000;
let store: Store<BaiduDramaStore> | null = null;
let temporaryAssetCleanupTask: ScheduledTask | null = null;

function getStore() {
  store ??= new Store<BaiduDramaStore>({
    name: "baidu-drama-config",
    defaults: { config: defaultConfig },
  });
  return store;
}

function numberText(value: string | undefined, fallback: string, minimum: number) {
  const number = Number.parseFloat(value ?? "");
  return Number.isFinite(number) && number >= minimum ? String(value).trim() : fallback;
}

function normalizeConfig(config: Partial<BaiduDramaConfig>): BaiduDramaConfig {
  return {
    apiBaseUrl: config.apiBaseUrl?.trim() || defaultConfig.apiBaseUrl,
    localEpisodeVideoRoot: config.localEpisodeVideoRoot?.trim() ?? "",
    baiduNetdiskDownloadRetryAttempts: numberText(
      config.baiduNetdiskDownloadRetryAttempts,
      defaultConfig.baiduNetdiskDownloadRetryAttempts,
      0,
    ),
    episodeUploadWaitTimeoutMinutes: numberText(
      config.episodeUploadWaitTimeoutMinutes,
      defaultConfig.episodeUploadWaitTimeoutMinutes,
      1,
    ),
    headless: config.headless ?? defaultConfig.headless,
    operationDelaySeconds: numberText(config.operationDelaySeconds, defaultConfig.operationDelaySeconds, 0),
    taskPollIntervalSeconds: numberText(config.taskPollIntervalSeconds, defaultConfig.taskPollIntervalSeconds, 1),
    runDataDir: config.runDataDir?.trim() || defaultConfig.runDataDir,
    logRetentionDays: numberText(config.logRetentionDays, defaultConfig.logRetentionDays, 1),
  };
}

function readConfig() {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("baidu-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function taskClaimResumeAt(accountId: string) {
  const resumeAt = getStore().get("taskClaimResumeAtByAccount", {})[accountId];
  if (!resumeAt || resumeAt <= Date.now()) return undefined;
  return resumeAt;
}

function saveTaskClaimResumeAt(accountId: string, resumeAt: number) {
  const resumeAtByAccount = getStore().get("taskClaimResumeAtByAccount", {});
  getStore().set("taskClaimResumeAtByAccount", {
    ...resumeAtByAccount,
    [accountId]: resumeAt,
  });
}

function storagePaths(
  config = readConfig(),
  accountProfileName = "default",
): BaiduDramaStoragePaths {
  const runDataDir = resolveFromAppRoot(config.runDataDir);
  const encodedProfileName = encodeURIComponent(accountProfileName.trim() || "default");
  const accountDir = path.join(runDataDir, "auth", "accounts", encodedProfileName);
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
    assetDownloadDir: path.join(runDataDir, "assets", encodedProfileName),
    logDir,
    logFilePath: path.join(logDir, `app-${dateKey}.log`),
  };
}

function registerBaiduRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: "baidu-drama",
    rootPath: path.join(storagePaths(config).runDataDir, "assets"),
    maxDepth: 2,
    retentionMs: 3 * 60 * 60 * 1000,
  });
}

function baiduDramaPlatformLogger(scope = "runtime") {
  const paths = storagePaths();
  return createElectronPlatformLogger({
    platform: "baidu-drama",
    scope,
    logDir: paths.logDir,
    retentionDays: Number.parseInt(readConfig().logRetentionDays, 10) || 3,
  });
}

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function removeBaiduTemporaryAsset(target: string, recursive = false) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(target, { recursive, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      if (!["EBUSY", "EACCES", "EPERM"].includes(code ?? "") || attempt >= 5) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt * 500);
      });
    }
  }
}

function safeDirectChild(root: string, entryName: string) {
  const target = path.resolve(root, entryName);
  const relative = path.relative(root, target);
  if (
    relative !== entryName
    || relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    return null;
  }
  return target;
}

async function cleanupStaleBaiduTemporaryAssets(now = new Date()) {
  const config = readConfig();
  const assetsRoot = path.resolve(resolveFromAppRoot(config.runDataDir), "assets");
  const aiCoverCutoffMs = now.getTime() - baiduAiCoverTemporaryFileRetentionMs;
  const rootEntries = await readdir(assetsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingPathError(error)) return [];
    throw error;
  });
  const accountAssetRoots: string[] = [];
  let deletedFileCount = 0;
  let failedCount = 0;

  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) continue;
    const rootDirectory = safeDirectChild(assetsRoot, rootEntry.name);
    if (!rootDirectory) continue;

    // Upload staging directories are handled by the shared lease-aware cleanup.
    if (/^episode-upload-\d+$/.test(rootEntry.name)) continue;

    accountAssetRoots.push(rootDirectory);
  }

  for (const accountAssetRoot of accountAssetRoots) {
    const cacheRoot = path.join(accountAssetRoot, "ai-cover-cache");
    const cacheRootStat = await lstat(cacheRoot).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      failedCount += 1;
      baiduDramaPlatformLogger("storage").warn("AI cover cache directory check failed; ignored", {
        path: cacheRoot,
        error,
      });
      return undefined;
    });
    if (!cacheRootStat?.isDirectory() || cacheRootStat.isSymbolicLink()) continue;

    const cacheEntries = await readdir(cacheRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissingPathError(error)) return [];
      failedCount += 1;
      baiduDramaPlatformLogger("storage").warn("AI cover cache directory scan failed; ignored", {
        path: cacheRoot,
        error,
      });
      return [];
    });
    for (const cacheEntry of cacheEntries) {
      if (!cacheEntry.isDirectory() || cacheEntry.isSymbolicLink()) continue;
      const cacheDirectory = safeDirectChild(cacheRoot, cacheEntry.name);
      if (!cacheDirectory) continue;
      const entries = await readdir(cacheDirectory, { withFileTypes: true }).catch((error: unknown) => {
        if (isMissingPathError(error)) return [];
        failedCount += 1;
        baiduDramaPlatformLogger("storage").warn("AI cover cache subdirectory scan failed; ignored", {
          path: cacheDirectory,
          error,
        });
        return [];
      });
      for (const entry of entries) {
        if (!entry.isFile() || !baiduAiCoverTemporaryFilePattern.test(entry.name)) continue;
        const file = safeDirectChild(cacheDirectory, entry.name);
        if (!file) continue;
        const fileStat = await stat(file).catch((error: unknown) => {
          if (isMissingPathError(error)) return undefined;
          failedCount += 1;
          baiduDramaPlatformLogger("storage").warn("AI cover temporary file check failed; ignored", {
            path: file,
            error,
          });
          return undefined;
        });
        if (!fileStat?.isFile() || fileStat.mtimeMs > aiCoverCutoffMs) continue;

        try {
          await removeBaiduTemporaryAsset(file);
          deletedFileCount += 1;
        } catch (error) {
          failedCount += 1;
          baiduDramaPlatformLogger("storage").warn("AI cover temporary file cleanup failed; ignored", {
            path: file,
            error,
          });
        }
      }
    }
  }

  baiduDramaPlatformLogger("storage").info("Temporary file scheduled cleanup completed", {
    deletedFileCount,
    failedCount,
    aiCoverRetentionHours: baiduAiCoverTemporaryFileRetentionMs / 3_600_000,
  });
}

function scheduleBaiduTemporaryAssetCleanup() {
  if (temporaryAssetCleanupTask) return;

  const runCleanup = () => cleanupStaleBaiduTemporaryAssets().catch((error: unknown) => {
    baiduDramaPlatformLogger("storage").warn("Temporary file scheduled cleanup failed; ignored", { error });
  });
  temporaryAssetCleanupTask = cron.schedule("0 * * * *", runCleanup, {
    name: "baidu-temporary-asset-cleanup",
    timezone: "Asia/Shanghai",
    noOverlap: true,
    unref: true,
  });
  void runCleanup();
  baiduDramaPlatformLogger("storage").info("Temporary file scheduled cleanup enabled", {
    targets: "AI cover originals",
    aiCoverRetention: "24 hours",
    schedule: "on startup and every hour",
  });
}

function ensureStorageDirectories(paths = storagePaths()) {
  for (const target of [paths.runDataDir, paths.accountDir, paths.userDataDir, paths.assetDownloadDir, paths.logDir]) {
    mkdirSync(target, { recursive: true });
  }
}

async function defaultStoppedStatus(): Promise<BaiduDramaServiceStatus> {
  return {
    platform: "baidu-drama",
    running: false,
    createUrl: "https://duanju.baidu.com/builder/rc/edit?type=playlet&sub_type=create_playlet_type&action=new",
    loginUrl: "https://duanju.baidu.com/builder/theme/playletPlat/product",
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<BaiduDramaServiceStatus> {
  const runtime = runtimeController.current;
  if (!runtime) return defaultStoppedStatus();

  const runtimeStatus = runtime.getStatus();
  if (!runtimeStatus.running) {
    await runtimeController.stop();
    return defaultStoppedStatus();
  }
  return { ...runtimeStatus, pid: process.pid };
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const configuredVideoRoot = config.localEpisodeVideoRoot.trim();
  if (!configuredVideoRoot) {
    throw new Error("请先在百度短剧配置中选择剧集视频根目录，再启动服务。");
  }
  const localEpisodeVideoRoot = resolveFromAppRoot(configuredVideoRoot);
  if (!existsSync(localEpisodeVideoRoot) || !statSync(localEpisodeVideoRoot).isDirectory()) {
    throw new Error(`百度短剧剧集视频根目录不存在或不是文件夹：${localEpisodeVideoRoot}`);
  }
  const { fetchBaiduDramaAccounts, startBaiduDramaRuntime } = await import("@drama/baidu-drama-automation") as {
    fetchBaiduDramaAccounts: (apiBaseUrl: string) => Promise<BaiduDramaAccount[]>;
    startBaiduDramaRuntime: (options: Record<string, unknown>) => Promise<BaiduDramaAccountRuntime>;
  };
  const accounts = await fetchBaiduDramaAccounts(config.apiBaseUrl);
  if (!accounts.length) throw new Error("BAIDU_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");

  const accountRuntimes: Array<{
    account: BaiduDramaAccount;
    runtime: BaiduDramaAccountRuntime;
  }> = [];
  let running = true;

  try {
    baiduDramaPlatformLogger("browser").info("Starting account browsers in parallel", {
      accountCount: accounts.length,
      accounts: accounts.map((account) => ({
        accountId: account.accountId,
        accountName: account.accountName,
      })),
    });
    const startupResults = await Promise.allSettled(accounts.map(async (account) => {
      const accountProfileName = account.rpaProfileKey?.trim() || account.accountId;
      const paths = storagePaths(config, accountProfileName);
      ensureStorageDirectories(paths);
      const runtime = await startBaiduDramaRuntime({
        accountProfileName,
        baiduAccountId: account.accountId,
        baiduAccountName: account.accountName,
        userDataDir: paths.userDataDir,
        credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir,
        logFilePath: paths.logFilePath,
        logRetentionDays: Number.parseInt(config.logRetentionDays, 10),
        localEpisodeVideoRoot,
        baiduNetdiskDownloadRetryAttempts: Number.parseInt(config.baiduNetdiskDownloadRetryAttempts, 10),
        episodeUploadWaitTimeoutMinutes: Number.parseFloat(config.episodeUploadWaitTimeoutMinutes),
        taskPollIntervalMs: Number.parseFloat(config.taskPollIntervalSeconds) * 1000,
        taskClaimResumeAt: taskClaimResumeAt(account.accountId),
        onTaskClaimPaused: (resumeAt: number) =>
          saveTaskClaimResumeAt(account.accountId, resumeAt),
        createAiClient: createConfiguredAiClient,
        aiImageModel: getConfiguredAiImageModel(),
        aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        apiConfig: { baseUrl: config.apiBaseUrl },
        ensureBaiduNetdiskResource: (request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0]) => ensureBaiduNetdiskShareDownloaded({
          ...request,
          requesterPlatform: "baidu-drama",
        }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        config: {
          browser: {
            headless: config.headless === "true",
            slowMo: Number.parseFloat(config.operationDelaySeconds) * 1000,
          },
        },
      });
      return { account, runtime };
    }));
    for (const result of startupResults) {
      if (result.status === "fulfilled") accountRuntimes.push(result.value);
    }
    const startupFailure = startupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (startupFailure) {
      throw startupFailure.reason;
    }
  } catch (error) {
    running = false;
    await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop()));
    throw error;
  }

  return {
    getStatus(): BaiduDramaRuntimeStatus {
      const runtimeAccounts = accountRuntimes.map(({ account, runtime }) => {
        const accountStatus = runtime.getStatus();
        return {
          ...accountStatus,
          accountId: account.accountId,
          accountName: account.accountName,
          loginAccount: account.loginAccount,
          launched: accountStatus.running,
        };
      });
      if (runtimeAccounts.every((account) => !account.launched)) running = false;
      return {
        platform: "baidu-drama",
        running,
        createUrl: "https://duanju.baidu.com/builder/rc/edit?type=playlet&sub_type=create_playlet_type&action=new",
        loginUrl: "https://duanju.baidu.com/builder/theme/playletPlat/product",
        accounts: runtimeAccounts,
      };
    },
    async stop() {
      running = false;
      await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop()));
      baiduDramaPlatformLogger("browser").info("All account browsers stopped");
    },
  };
}

export function getBaiduDramaBrowserInstanceCount() {
  return runtimeController.current
    ?.getStatus()
    .accounts.filter((account) => account.launched).length ?? 0;
}

export function getBaiduDramaRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getBaiduDramaPlatformRuntimeSummary() {
  const runtime = runtimeController.current?.getStatus();
  const runningAccounts = runtime?.accounts.filter((account) => account.launched) ?? [];
  return {
    platform: "baidu-drama" as const,
    running: Boolean(runtime?.running),
    browserInstanceCount: runningAccounts.length,
    browserInstances: runningAccounts.map((account) => ({
      id: account.accountId,
      label: account.accountName,
      loginState: account.loginState,
      activeUrl: account.activeUrl,
    })),
    logDir: storagePaths().logDir,
  };
}

export function openBaiduDramaLogDir() {
  const paths = storagePaths();
  mkdirSync(paths.logDir, { recursive: true });
  return openExistingPath(paths.logDir);
}

export function registerBaiduDramaPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "baidu-drama",
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: "/dramaAiRpa/baidu",
  });
  registerBaiduRuntimeAssetCleanup();
  scheduleBaiduTemporaryAssetCleanup();

  ipcMain.handle("baidu-drama:config:get", () => ({
    config: readConfig(),
    path: getStore().path,
    storagePaths: storagePaths(),
    restartRequired: false,
  }));
  ipcMain.handle("baidu-drama:config:save", (_event, config: BaiduDramaConfig) => {
    const nextConfig = normalizeConfig(config);
    getStore().set("config", nextConfig);
    registerBaiduRuntimeAssetCleanup(readConfig());
    return {
      config: nextConfig,
      path: getStore().path,
      storagePaths: storagePaths(nextConfig),
      restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
    };
  });
  ipcMain.handle("baidu-drama:config:select-run-data-dir", async (event, currentPath?: string) => {
    const selected = await selectDirectory(event, {
      title: "选择百度短剧运行数据目录",
      defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
      properties: ["openDirectory", "createDirectory"],
    });
    return normalizePlatformRunDataDir(selected, "baidu-drama");
  });
  ipcMain.handle("baidu-drama:config:select-local-episode-video-root", (event, currentPath?: string) =>
    selectDirectory(event, {
      title: "选择百度短剧剧集视频根目录",
      defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
      properties: ["openDirectory", "createDirectory"],
    }),
  );
  ipcMain.handle("baidu-drama:service:status", () => status());
  ipcMain.handle("baidu-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    await runtimeController.start(startRuntime);
    return status();
  });
  ipcMain.handle("baidu-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopBaiduDramaPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopBaiduDramaPlatformService() {
  return runtimeController.stop();
}
