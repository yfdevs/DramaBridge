import { createAccountRuntimeGroup } from "../shared/account-runtime-group";
import { registerAccountControl } from "../shared/account-control";
import { app } from "electron";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import cron, { type ScheduledTask } from "node-cron";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  directoryDefaultPath,
  ensureDirectories,
  findLatestFile,
  normalizePlatformRunDataDir,
  openExistingPath,
  openPathOrParent,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "../shared";
import {
  cleanupBaiduNetdiskPlayletAfterTaskSuccess,
  ensureBaiduNetdiskShareDownloaded,
} from "../baidu-netdisk";
import { createElectronPlatformLogger } from "../../platform-logger";
import { registerRuntimeAssetCleanupRoot } from "../../runtime-asset-cleanup";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";

type WeiboDramaLoginState = "login-required" | "logged-in" | "unknown";

type WeiboDramaAccount = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};

type WeiboDramaAccountRuntimeStatus = {
  platform: "weibo-drama";
  running: boolean;
  loginState: WeiboDramaLoginState;
  activeUrl?: string;
  addUrl: string;
  loginUrl: string;
  userDataDir: string;
  accountProfileName?: string;
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

type WeiboDramaAccountRuntime = {
  getStatus: () => WeiboDramaAccountRuntimeStatus;
  stop: () => Promise<void>;
};

type WeiboDramaRuntimeStatus = {
  platform: "weibo-drama";
  running: boolean;
  addUrl: string;
  loginUrl: string;
  accounts: Array<
    WeiboDramaAccountRuntimeStatus & {
      accountId: string;
      accountName: string;
      loginAccount?: string | null;
      launched: boolean;
    }
  >;
};

type WeiboDramaRuntime = {
  getStatus: () => WeiboDramaRuntimeStatus;
  stop: () => Promise<void>;
};

export type WeiboDramaConfig = {
  accountProfileName: string;
  apiBaseUrl: string;
  localEpisodeVideoRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
  episodeUploadWaitTimeoutMinutes: string;
  episodeUploadFailedRetryAttempts: string;
  keepFailedTaskPages: string;
  headless: string;
  operationDelaySeconds: string;
  taskPollIntervalSeconds: string;
  runDataDir: string;
  logRetentionDays: string;
};

type WeiboDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type WeiboDramaServiceStatus = WeiboDramaRuntimeStatus & {
  pid: number | null;
};

type WeiboDramaConfigResult = {
  config: WeiboDramaConfig;
  path: string;
  storagePaths: WeiboDramaStoragePaths;
  restartRequired: boolean;
};

type WeiboDramaStore = {
  config: Partial<WeiboDramaConfig> & Record<string, string | undefined>;
};

const defaultWeiboDramaConfig: WeiboDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  episodeUploadFailedRetryAttempts: "3",
  keepFailedTaskPages: "true",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir:
    process.platform === "win32" ? "D:\\.drama-runs\\weibo-drama" : ".drama-runs/weibo-drama",
  logRetentionDays: "3",
};

const runtimeController = new RuntimeController<WeiboDramaRuntime>();
let store: Store<WeiboDramaStore> | null = null;
let contractCleanupTask: ScheduledTask | null = null;

export function getWeiboDramaBrowserInstanceCount() {
  return (
    runtimeController.current?.getStatus().accounts.filter((account) => account.launched).length ??
    0
  );
}

export function getWeiboDramaRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getWeiboDramaPlatformRuntimeSummary() {
  const runtimeStatus = runtimeController.current?.getStatus();
  const running = Boolean(runtimeStatus?.running);
  const paths = storagePaths();

  return {
    platform: "weibo-drama" as const,
    running,
    startedAt: runtimeController.startedAt,
    browserInstanceCount: runtimeStatus?.accounts.filter((account) => account.launched).length ?? 0,
    browserInstances:
      runtimeStatus?.accounts
        .filter((account) => account.launched)
        .map((account) => ({
          id: account.accountId,
          label: account.accountName,
          loginState: account.loginState,
          activeUrl: account.activeUrl,
        })) ?? [],
    logDir: paths.logDir,
  };
}

export function openWeiboDramaLogDir() {
  const paths = storagePaths();
  ensureDirectories([paths.logDir]);
  return openExistingPath(paths.logDir);
}

function getStore() {
  if (!store) {
    store = createValidatedStore<WeiboDramaStore>({
      name: "weibo-drama-config",
      defaults: {
        config: defaultWeiboDramaConfig,
      },
    });
  }

  return store;
}

function normalizeNumberText(value: string | undefined, fallback: string, minimum = 0) {
  const nextValue = value?.trim();
  if (!nextValue) return fallback;

  const numericValue = Number.parseFloat(nextValue);
  if (!Number.isFinite(numericValue) || numericValue < minimum) {
    return fallback;
  }

  return nextValue;
}

function normalizeConfig(
  config: Partial<WeiboDramaConfig> & Record<string, string | undefined>,
): WeiboDramaConfig {
  return {
    accountProfileName:
      config.accountProfileName?.trim() || defaultWeiboDramaConfig.accountProfileName,
    apiBaseUrl: config.apiBaseUrl?.trim() || defaultWeiboDramaConfig.apiBaseUrl,
    localEpisodeVideoRoot:
      config.localEpisodeVideoRoot ?? defaultWeiboDramaConfig.localEpisodeVideoRoot,
    baiduNetdiskDownloadRetryAttempts: normalizeNumberText(
      config.baiduNetdiskDownloadRetryAttempts,
      defaultWeiboDramaConfig.baiduNetdiskDownloadRetryAttempts,
      0,
    ),
    episodeUploadWaitTimeoutMinutes: normalizeNumberText(
      config.episodeUploadWaitTimeoutMinutes,
      defaultWeiboDramaConfig.episodeUploadWaitTimeoutMinutes,
      1,
    ),
    episodeUploadFailedRetryAttempts: normalizeNumberText(
      config.episodeUploadFailedRetryAttempts,
      defaultWeiboDramaConfig.episodeUploadFailedRetryAttempts,
      0,
    ),
    keepFailedTaskPages: config.keepFailedTaskPages ?? "true",
    headless: config.headless ?? defaultWeiboDramaConfig.headless,
    operationDelaySeconds: normalizeNumberText(
      config.operationDelaySeconds,
      defaultWeiboDramaConfig.operationDelaySeconds,
    ),
    taskPollIntervalSeconds: normalizeNumberText(
      config.taskPollIntervalSeconds,
      defaultWeiboDramaConfig.taskPollIntervalSeconds,
      1,
    ),
    runDataDir:
      !config.runDataDir ||
      config.runDataDir === ".drama-runs" ||
      config.runDataDir === ".drama-runs/weibo-drama"
        ? defaultWeiboDramaConfig.runDataDir
        : config.runDataDir,
    logRetentionDays: normalizeNumberText(
      config.logRetentionDays,
      defaultWeiboDramaConfig.logRetentionDays,
      1,
    ),
  };
}

function readConfig(): WeiboDramaConfig {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("weibo-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function writeConfig(config: WeiboDramaConfig) {
  getStore().set("config", config);
}

function configPath() {
  return getStore().path;
}

function weiboDramaRunDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function encodedAccountProfileName(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return encodeURIComponent(accountProfileName.trim() || "default");
}

function weiboDramaAccountDir(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(
    weiboDramaRunDataDir(config),
    "auth",
    "accounts",
    encodedAccountProfileName(config, accountProfileName),
  );
}

function weiboDramaUserDataDir(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(weiboDramaAccountDir(config, accountProfileName), "chromium-profile");
}

function weiboDramaCredentialStatePath(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(weiboDramaAccountDir(config, accountProfileName), "storage-state.json");
}

function weiboDramaAssetDownloadDir(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(
    weiboDramaRunDataDir(config),
    "assets",
    encodedAccountProfileName(config, accountProfileName),
  );
}

function isMissingContractPathError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function latestContractModifiedAtMs(target: string): Promise<number> {
  const targetStat = await lstat(target);
  let latest = targetStat.mtimeMs;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return latest;

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    latest = Math.max(latest, await latestContractModifiedAtMs(path.join(target, entry.name)));
  }
  return latest;
}

async function cleanupPreviousWeiboCopyrightProofs(now = new Date()) {
  const assetsRoot = path.resolve(weiboDramaRunDataDir(), "assets");
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let accountEntries;
  try {
    accountEntries = await readdir(assetsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingContractPathError(error)) return;
    throw error;
  }

  let deletedCount = 0;
  for (const accountEntry of accountEntries) {
    if (!accountEntry.isDirectory() || accountEntry.isSymbolicLink()) continue;
    const proofRoot = path.join(assetsRoot, accountEntry.name, "copyright-proofs");
    const taskEntries = await readdir(proofRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isMissingContractPathError(error)) return [];
        throw error;
      },
    );
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) continue;
      const taskDir = path.resolve(proofRoot, taskEntry.name);
      const relativeTaskDir = path.relative(proofRoot, taskDir);
      if (
        !relativeTaskDir ||
        relativeTaskDir.startsWith("..") ||
        path.isAbsolute(relativeTaskDir)
      ) {
        continue;
      }
      const modifiedAtMs = await latestContractModifiedAtMs(taskDir).catch((error: unknown) => {
        if (isMissingContractPathError(error)) return startOfToday;
        throw error;
      });
      if (modifiedAtMs >= startOfToday) continue;

      await rm(taskDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      deletedCount += 1;
      weiboPlatformLogger("storage").info("Deleted expired copyright materials", { path: taskDir });
    }
  }
  weiboPlatformLogger("storage").info("Expired copyright materials cleanup completed", {
    deletedCount,
  });
}

function scheduleWeiboCopyrightProofCleanup() {
  if (contractCleanupTask) return;
  contractCleanupTask = cron.schedule(
    "0 1 * * *",
    async () => {
      await cleanupPreviousWeiboCopyrightProofs().catch((error: unknown) => {
        weiboPlatformLogger("storage").error("Expired copyright materials cleanup failed", {
          error,
        });
      });
    },
    {
      name: "weibo-copyright-proof-cleanup",
      timezone: "Asia/Shanghai",
      noOverlap: true,
      unref: true,
    },
  );
  weiboPlatformLogger("storage").info("Copyright materials scheduled cleanup enabled", {
    schedule: "daily at 01:00",
  });
}

function weiboDramaLogDir(config = readConfig()) {
  return path.join(weiboDramaRunDataDir(config), "logs");
}

function weiboPlatformLogger(scope = "runtime") {
  const config = readConfig();
  return createElectronPlatformLogger({
    platform: "weibo-drama",
    scope,
    logDir: weiboDramaLogDir(config),
    retentionDays: Number.parseInt(config.logRetentionDays, 10) || 3,
  });
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weiboDramaLogFile(config = readConfig()) {
  return path.join(weiboDramaLogDir(config), `app-${formatDateKey()}.json`);
}

function storagePaths(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
): WeiboDramaStoragePaths {
  return {
    runDataDir: weiboDramaRunDataDir(config),
    accountDir: weiboDramaAccountDir(config, accountProfileName),
    userDataDir: weiboDramaUserDataDir(config, accountProfileName),
    credentialStatePath: weiboDramaCredentialStatePath(config, accountProfileName),
    assetDownloadDir: weiboDramaAssetDownloadDir(config, accountProfileName),
    logDir: weiboDramaLogDir(config),
    logFilePath: weiboDramaLogFile(config),
  };
}

function registerWeiboRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: "weibo-drama",
    rootPath: path.join(storagePaths(config).runDataDir, "assets"),
    maxDepth: 2,
    retentionMs: 3 * 60 * 60 * 1000,
  });
}

function ensureStorageDirectories(paths = storagePaths()) {
  ensureDirectories([
    paths.runDataDir,
    paths.accountDir,
    paths.userDataDir,
    paths.assetDownloadDir,
    paths.logDir,
  ]);
}

function findLatestLogPath(paths = storagePaths()) {
  return findLatestFile(paths.logDir, (fileName) =>
    /^app(?:-.+)?-\d{4}-\d{2}-\d{2}\.(?:log|jsonl)$/i.test(fileName),
  );
}

async function importWeiboDramaRuntimePackage() {
  return import("@dramabridge/weibo-drama-automation") as Promise<{
    fetchWeiboDramaAccounts: (
      apiBaseUrl: string,
      fetcher?: typeof fetch,
    ) => Promise<WeiboDramaAccount[]>;
    startWeiboDramaRuntime: (options: Record<string, unknown>) => Promise<WeiboDramaAccountRuntime>;
  }>;
}

async function defaultStoppedStatus(): Promise<WeiboDramaServiceStatus> {
  return {
    platform: "weibo-drama",
    running: false,
    addUrl: "https://duanju.mcn.weibo.com/content/series/publish",
    loginUrl: "https://duanju.mcn.weibo.com/content/series/publish",
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<WeiboDramaServiceStatus> {
  const runtime = runtimeController.current;
  if (!runtime) return defaultStoppedStatus();

  const runtimeStatus = runtime.getStatus();
  if (!runtimeStatus.running) {
    await runtimeController.stop();
    return defaultStoppedStatus();
  }

  return {
    ...runtimeStatus,
    pid: process.pid,
  };
}

async function startRuntime(selectedAccountIds: unknown) {
  return createAccountRuntimeGroup(selectedAccountIds, (id, canClaimTask) =>
    startAccountRuntime([id], canClaimTask),
  );
}

async function startAccountRuntime(selectedAccountIds: unknown, canClaimTask: () => boolean) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();

  const config = readConfig();
  const operationDelayMs = Math.max(0, Number.parseFloat(config.operationDelaySeconds) || 0) * 1000;
  const logRetentionDays = Math.max(1, Number.parseInt(config.logRetentionDays, 10) || 3);
  const baiduNetdiskDownloadRetryAttempts = Math.max(
    0,
    Number.parseInt(config.baiduNetdiskDownloadRetryAttempts, 10) || 0,
  );
  const episodeUploadFailedRetryAttempts = Math.max(
    0,
    Number.parseInt(config.episodeUploadFailedRetryAttempts, 10) || 0,
  );
  const episodeUploadWaitTimeoutMinutes = Math.max(
    1,
    Number.parseFloat(config.episodeUploadWaitTimeoutMinutes) || 120,
  );
  const taskPollIntervalMs =
    Math.max(1, Number.parseFloat(config.taskPollIntervalSeconds) || 10) * 1000;
  const { fetchWeiboDramaAccounts, startWeiboDramaRuntime } =
    await importWeiboDramaRuntimePackage();
  const availableAccounts = await fetchWeiboDramaAccounts(config.apiBaseUrl);
  if (
    !Array.isArray(selectedAccountIds) ||
    !selectedAccountIds.length ||
    selectedAccountIds.some((id) => typeof id !== "string")
  )
    throw new Error("请选择要启动的账号");
  const ids = new Set(selectedAccountIds);
  const accounts = availableAccounts.filter((account) => ids.has(account.accountId));
  if (accounts.length !== ids.size) throw new Error("所选账号已失效，请刷新账号列表后重试");
  if (!accounts.length) {
    throw new Error("WEIBO_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");
  }
  weiboPlatformLogger("account").info("Loaded enabled accounts", {
    count: accounts.length,
    accounts: accounts.map((account) => ({ id: account.accountId, name: account.accountName })),
  });

  const accountRuntimes: Array<{
    account: WeiboDramaAccount;
    runtime: WeiboDramaAccountRuntime;
  }> = [];
  let running = true;

  try {
    for (const account of accounts) {
      const paths = storagePaths(config, account.accountId);
      ensureStorageDirectories(paths);
      const runtime = await startWeiboDramaRuntime({
        canClaimTask,
        accountProfileName: account.accountId,
        weiboAccountId: account.accountId,
        weiboAccountName: account.accountName,
        accountDir: paths.accountDir,
        userDataDir: paths.userDataDir,
        credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir,
        logFilePath: paths.logFilePath,
        logRetentionDays,
        localEpisodeVideoRoot: config.localEpisodeVideoRoot,
        baiduNetdiskDownloadRetryAttempts,
        episodeUploadWaitTimeoutMinutes,
        episodeUploadFailedRetryAttempts,
        failedTaskPageRetention: config.keepFailedTaskPages === "false" ? "close" : "keep",
        taskPollIntervalMs,
        aiClientFactory: createConfiguredAiClient,
        aiImageModel: getConfiguredAiImageModel(),
        aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        ensureBaiduNetdiskResource: (
          request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0],
        ) =>
          ensureBaiduNetdiskShareDownloaded({
            ...request,
            requesterPlatform: "weibo-drama",
          }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        apiConfig: {
          baseUrl: config.apiBaseUrl,
        },
        config: {
          browser: {
            headless: config.headless === "true",
            slowMo: operationDelayMs,
          },
        },
      });
      accountRuntimes.push({ account, runtime });
    }
  } catch (error) {
    running = false;
    await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop()));
    throw error;
  }

  return {
    getStatus(): WeiboDramaRuntimeStatus {
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
      if (runtimeAccounts.every((account) => !account.launched)) {
        running = false;
      }
      return {
        platform: "weibo-drama",
        running,
        addUrl: "https://duanju.mcn.weibo.com/content/series/publish",
        loginUrl: "https://duanju.mcn.weibo.com/content/series/publish",
        accounts: runtimeAccounts,
      };
    },
    async stop() {
      running = false;
      await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop()));
      weiboPlatformLogger("browser").info("All account browsers stopped");
    },
  };
}

export function registerWeiboDramaPlatformHandlers() {
  registerAccountControl({
    platform: "weibo-drama",
    controller: runtimeController,
    start: startRuntime,
    status,
  });
  registerWeiboRuntimeAssetCleanup();
  scheduleWeiboCopyrightProofCleanup();

  ipcMain.handle("weibo-drama:config:get", () => ({
    config: readConfig(),
    path: configPath(),
    storagePaths: storagePaths(),
    restartRequired: false,
  }));

  ipcMain.handle(
    "weibo-drama:config:save",
    (_event, config: WeiboDramaConfig): WeiboDramaConfigResult => {
      const nextConfig = normalizeConfig(config);
      writeConfig(nextConfig);
      registerWeiboRuntimeAssetCleanup(readConfig());
      return {
        config: nextConfig,
        path: configPath(),
        storagePaths: storagePaths(nextConfig),
        restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
      };
    },
  );

  ipcMain.handle("weibo-drama:config:select-run-data-dir", async (event, currentPath?: string) => {
    const selectedPath = await selectDirectory(event, {
      title: "选择 微博 短剧运行数据目录",
      defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
      properties: ["openDirectory", "createDirectory"],
    });

    return normalizePlatformRunDataDir(selectedPath, "weibo-drama");
  });

  ipcMain.handle(
    "weibo-drama:config:select-local-episode-video-root",
    async (event, currentPath?: string) => {
      return selectDirectory(event, {
        title: "选择 微博 短剧剧集视频根目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
        properties: ["openDirectory", "createDirectory"],
      });
    },
  );

  ipcMain.handle(
    "weibo-drama:config:open-storage-path",
    async (_event, key: keyof WeiboDramaStoragePaths | "configFilePath" | "latestLog") => {
      const paths = storagePaths();
      ensureStorageDirectories(paths);

      if (key === "configFilePath") {
        return openPathOrParent(configPath());
      }
      if (key === "latestLog") {
        return openExistingPath(findLatestLogPath(paths));
      }
      if (key === "credentialStatePath" || key === "logFilePath") {
        return openPathOrParent(paths[key]);
      }
      return openExistingPath(paths[key]);
    },
  );

  ipcMain.handle("weibo-drama:service:status", () => status());

  ipcMain.handle("weibo-drama:accounts:list", async () => {
    const { fetchWeiboDramaAccounts } = await importWeiboDramaRuntimePackage();
    return (await fetchWeiboDramaAccounts(readConfig().apiBaseUrl)).map((account) => ({
      accountId: account.accountId,
      accountName: account.accountName,
    }));
  });
  ipcMain.handle("weibo-drama:service:start", async (_event, selectedAccountIds: unknown) => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) {
      await runtimeController.stop();
    }

    await runtimeController.start(() => startRuntime(selectedAccountIds));
    return status();
  });

  ipcMain.handle("weibo-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopWeiboDramaPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopWeiboDramaPlatformService() {
  return runtimeController.stop();
}
