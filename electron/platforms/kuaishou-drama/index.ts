import { app } from "electron";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import { registerTaskAnalyticsHandler } from "../shared/task-analytics";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from "../baidu-netdisk";
import { createElectronPlatformLogger } from "../../platform-logger";
import { registerRuntimeAssetCleanupRoot } from "../../runtime-asset-cleanup";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";
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

type KuaishouDramaAccountRuntimeStatus = {
  platform: "kuaishou-drama";
  running: boolean;
  loginState: "login-required" | "logged-in" | "unknown";
  activeUrl?: string;
  userDataDir: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle?: string;
    status: "failed" | "running" | "succeeded";
    errorMessage?: string;
    updatedAt: string;
  };
};

type KuaishouDramaAccountRuntime = {
  getStatus: () => KuaishouDramaAccountRuntimeStatus;
  stop: () => Promise<void>;
};

type KuaishouDramaRuntimeStatus = {
  platform: "kuaishou-drama";
  running: boolean;
  accounts: Array<
    KuaishouDramaAccountRuntimeStatus & {
      accountId: string;
      accountName: string;
      loginAccount?: string | null;
      launched: boolean;
    }
  >;
};

type KuaishouDramaRuntime = {
  getStatus: () => KuaishouDramaRuntimeStatus;
  stop: () => Promise<void>;
};

export type KuaishouDramaConfig = {
  accountProfileName: string;
  apiBaseUrl: string;
  localEpisodeVideoRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
  videoUploadTimeoutMinutes: string;
  headless: string;
  operationDelaySeconds: string;
  taskPollIntervalSeconds: string;
  runDataDir: string;
  logRetentionDays: string;
};

export type KuaishouDramaServiceStatus = KuaishouDramaRuntimeStatus & {
  pid: number | null;
};

type KuaishouDramaConfigResult = {
  config: KuaishouDramaConfig;
  path: string;
  storagePaths: KuaishouDramaStoragePaths;
  restartRequired: boolean;
};

type KuaishouDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

type KuaishouDramaStore = {
  config: Partial<KuaishouDramaConfig> & Record<string, string | undefined>;
  dailyUploadLimitResumeAtByAccount?: Record<string, number>;
};

const defaultKuaishouDramaConfig: KuaishouDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  videoUploadTimeoutMinutes: "120",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: ".drama-runs/kuaishou-drama",
  logRetentionDays: "3",
};

const runtimeController = new RuntimeController<KuaishouDramaRuntime>();
let store: Store<KuaishouDramaStore> | null = null;

export function getKuaishouDramaBrowserInstanceCount() {
  return (
    runtimeController.current?.getStatus().accounts.filter((account) => account.launched).length ??
    0
  );
}

export function getKuaishouDramaRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getKuaishouDramaPlatformRuntimeSummary() {
  const runtimeStatus = runtimeController.current?.getStatus();
  const running = Boolean(runtimeStatus?.running);
  const paths = storagePaths();

  return {
    platform: "kuaishou-drama" as const,
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

export function openKuaishouDramaLogDir() {
  const paths = storagePaths();
  ensureDirectories([paths.logDir]);
  return openExistingPath(paths.logDir);
}

function normalizeOperationDelaySeconds(value: string | undefined) {
  const nextValue = value?.trim();
  if (!nextValue || nextValue === "0.02") {
    return defaultKuaishouDramaConfig.operationDelaySeconds;
  }

  const numericValue = Number.parseFloat(nextValue);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return defaultKuaishouDramaConfig.operationDelaySeconds;
  }

  return nextValue;
}

function getStore() {
  if (!store) {
    store = createValidatedStore<KuaishouDramaStore>({
      name: "kuaishou-drama-config",
      defaults: {
        config: defaultKuaishouDramaConfig,
      },
    });
  }

  return store;
}

function normalizeConfig(
  config: Partial<KuaishouDramaConfig> & Record<string, string | undefined>,
): KuaishouDramaConfig {
  return {
    accountProfileName:
      config.accountProfileName?.trim() || defaultKuaishouDramaConfig.accountProfileName,
    apiBaseUrl: config.apiBaseUrl?.trim() || defaultKuaishouDramaConfig.apiBaseUrl,
    localEpisodeVideoRoot:
      config.localEpisodeVideoRoot ?? defaultKuaishouDramaConfig.localEpisodeVideoRoot,
    baiduNetdiskDownloadRetryAttempts: /^\d+$/.test(
      config.baiduNetdiskDownloadRetryAttempts?.trim() ?? "",
    )
      ? config.baiduNetdiskDownloadRetryAttempts!.trim()
      : defaultKuaishouDramaConfig.baiduNetdiskDownloadRetryAttempts,
    videoUploadTimeoutMinutes:
      /^\d+$/.test(config.videoUploadTimeoutMinutes?.trim() ?? "") &&
      Number.parseInt(config.videoUploadTimeoutMinutes!.trim(), 10) >= 1
        ? config.videoUploadTimeoutMinutes!.trim()
        : defaultKuaishouDramaConfig.videoUploadTimeoutMinutes,
    headless: config.headless ?? defaultKuaishouDramaConfig.headless,
    operationDelaySeconds: normalizeOperationDelaySeconds(config.operationDelaySeconds),
    taskPollIntervalSeconds:
      Number.parseFloat(config.taskPollIntervalSeconds ?? "") >= 1
        ? config.taskPollIntervalSeconds!.trim()
        : defaultKuaishouDramaConfig.taskPollIntervalSeconds,
    runDataDir:
      !config.runDataDir || config.runDataDir === ".drama-runs"
        ? defaultKuaishouDramaConfig.runDataDir
        : config.runDataDir,
    logRetentionDays: config.logRetentionDays ?? defaultKuaishouDramaConfig.logRetentionDays,
  };
}

function readConfig(): KuaishouDramaConfig {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("kuaishou-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function writeConfig(config: KuaishouDramaConfig) {
  getStore().set("config", config);
}

function dailyUploadLimitResumeAt(accountId: string) {
  const resumeAt = getStore().get("dailyUploadLimitResumeAtByAccount", {})[accountId];
  if (!resumeAt || resumeAt <= Date.now()) return undefined;
  return resumeAt;
}

function saveDailyUploadLimitResumeAt(accountId: string, resumeAt: number) {
  const resumeAtByAccount = getStore().get("dailyUploadLimitResumeAtByAccount", {});
  getStore().set("dailyUploadLimitResumeAtByAccount", {
    ...resumeAtByAccount,
    [accountId]: resumeAt,
  });
}

function configPath() {
  return getStore().path;
}

function kuaishouDramaRunDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function encodedAccountProfileName(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return encodeURIComponent(accountProfileName.trim() || "default");
}

function kuaishouDramaAccountDir(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(
    kuaishouDramaRunDataDir(config),
    "auth",
    "accounts",
    encodedAccountProfileName(config, accountProfileName),
  );
}

function kuaishouDramaUserDataDir(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(kuaishouDramaAccountDir(config, accountProfileName), "chromium-profile");
}

function kuaishouDramaCredentialStatePath(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(kuaishouDramaAccountDir(config, accountProfileName), "storage-state.json");
}

function kuaishouDramaAssetDownloadDir(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
) {
  return path.join(
    kuaishouDramaRunDataDir(config),
    "assets",
    encodedAccountProfileName(config, accountProfileName),
  );
}

function kuaishouDramaLogDir(config = readConfig()) {
  return path.join(kuaishouDramaRunDataDir(config), "logs");
}

function kuaishouPlatformLogger(scope = "runtime") {
  const config = readConfig();
  return createElectronPlatformLogger({
    platform: "kuaishou-drama",
    scope,
    logDir: kuaishouDramaLogDir(config),
    retentionDays: Number.parseInt(config.logRetentionDays, 10) || 3,
  });
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function kuaishouDramaLogFile(config = readConfig()) {
  return path.join(kuaishouDramaLogDir(config), `app-${formatDateKey()}.log`);
}

function storagePaths(
  config = readConfig(),
  accountProfileName = config.accountProfileName,
): KuaishouDramaStoragePaths {
  return {
    runDataDir: kuaishouDramaRunDataDir(config),
    accountDir: kuaishouDramaAccountDir(config, accountProfileName),
    userDataDir: kuaishouDramaUserDataDir(config, accountProfileName),
    credentialStatePath: kuaishouDramaCredentialStatePath(config, accountProfileName),
    assetDownloadDir: kuaishouDramaAssetDownloadDir(config, accountProfileName),
    logDir: kuaishouDramaLogDir(config),
    logFilePath: kuaishouDramaLogFile(config),
  };
}

function registerKuaishouRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: "kuaishou-drama",
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

async function importKuaishouDramaRuntimePackage() {
  return import("@dramabridge/kuaishou-drama-automation") as Promise<{
    fetchKuaishouDramaAccounts: (apiBaseUrl: string) => Promise<
      Array<{
        id: number;
        accountId: string;
        accountName: string;
        loginAccount?: string | null;
        rpaProfileKey?: string | null;
      }>
    >;
    claimNextKuaishouDramaTaskApi: (options: Record<string, unknown>) => Promise<{
      accountTaskId: number;
      task: unknown;
    } | null>;
    reportKuaishouDramaTaskErrorApi: (task: {
      apiConfig: { baseUrl: string };
      accountTaskId: number;
      failStage: string;
      errorMessage: string;
    }) => Promise<void>;
    reportKuaishouDramaTaskSuccessApi: (task: {
      apiConfig: { baseUrl: string };
      accountTaskId: number;
      resultJson?: Record<string, unknown>;
    }) => Promise<void>;
    startKuaishouDramaRuntime: (
      options: Record<string, unknown>,
    ) => Promise<KuaishouDramaAccountRuntime>;
  }>;
}

function findLatestLogPath(paths = storagePaths()) {
  return findLatestFile(
    paths.logDir,
    (fileName) => /^app(?:-.+)?-\d{4}-\d{2}-\d{2}\.(?:log|jsonl)$/i.test(fileName),
  );
}

async function defaultStoppedStatus(): Promise<KuaishouDramaServiceStatus> {
  return {
    platform: "kuaishou-drama",
    running: false,
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<KuaishouDramaServiceStatus> {
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

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();

  const config = readConfig();
  let aiClient: ReturnType<typeof createConfiguredAiClient> | undefined;
  let aiImageModel: string | undefined;
  try {
    const configuredAiClient = createConfiguredAiClient();
    const configuredAiImageModel = getConfiguredAiImageModel();
    aiClient = configuredAiClient;
    aiImageModel = configuredAiImageModel;
  } catch (error) {
    kuaishouPlatformLogger("material").warn(
      "AI 配置不可用，服务仍会启动；缺少横版或竖版封面时无法自动补图",
      { error },
    );
  }
  const configuredVideoRoot = config.localEpisodeVideoRoot.trim();
  if (!configuredVideoRoot) {
    throw new Error("请先在快手短剧配置中选择本地剧集视频目录，再启动服务。");
  }
  const localEpisodeVideoRoot = resolveFromAppRoot(configuredVideoRoot);
  if (!existsSync(localEpisodeVideoRoot) || !statSync(localEpisodeVideoRoot).isDirectory()) {
    throw new Error(`快手短剧本地剧集视频目录不存在或不是文件夹：${localEpisodeVideoRoot}`);
  }

  const operationDelayMs = Math.max(0, Number.parseFloat(config.operationDelaySeconds) || 0) * 1000;
  const logRetentionDays = Math.max(1, Number.parseInt(config.logRetentionDays, 10) || 3);
  const baiduNetdiskDownloadRetryAttempts = Math.max(
    0,
    Number.parseInt(config.baiduNetdiskDownloadRetryAttempts, 10) || 0,
  );
  const videoUploadTimeoutMinutes = Math.max(
    1,
    Number.parseInt(config.videoUploadTimeoutMinutes, 10) || 120,
  );
  const taskPollIntervalMs =
    Math.max(1, Number.parseFloat(config.taskPollIntervalSeconds) || 10) * 1000;
  const {
    fetchKuaishouDramaAccounts,
    claimNextKuaishouDramaTaskApi,
    reportKuaishouDramaTaskErrorApi,
    reportKuaishouDramaTaskSuccessApi,
    startKuaishouDramaRuntime,
  } = await importKuaishouDramaRuntimePackage();
  const accounts = await fetchKuaishouDramaAccounts(config.apiBaseUrl);
  if (!accounts.length) throw new Error("KUAISHOU_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");

  const accountRuntimes: Array<{
    account: (typeof accounts)[number];
    runtime: KuaishouDramaAccountRuntime;
  }> = [];
  let running = true;
  try {
    for (const account of accounts) {
      const paths = storagePaths(config, account.accountId);
      ensureStorageDirectories(paths);
      const apiOptions = { apiConfig: { baseUrl: config.apiBaseUrl } };
      const runtimeOptions: Record<string, unknown> = {
        accountProfileName: account.accountId,
        kuaishouAccountId: account.accountId,
        kuaishouAccountName: account.accountName,
        accountDir: paths.accountDir,
        userDataDir: paths.userDataDir,
        credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir,
        logFilePath: paths.logFilePath,
        logRetentionDays,
        localEpisodeVideoRoot,
        baiduNetdiskDownloadRetryAttempts,
        videoUploadTimeoutMinutes,
        taskPollIntervalMs,
        dailyUploadLimitResumeAt: dailyUploadLimitResumeAt(account.accountId),
        onDailyUploadLimitReached: (resumeAt: number) =>
          saveDailyUploadLimitResumeAt(account.accountId, resumeAt),
        aiClient,
        aiImageModel,
        aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        apiConfig: apiOptions.apiConfig,
        ensureBaiduNetdiskResource: (request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0]) => ensureBaiduNetdiskShareDownloaded({
          ...request,
          requesterPlatform: "kuaishou-drama",
        }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        config: {
          browser: { headless: config.headless === "true", slowMo: operationDelayMs },
        },
      };
      runtimeOptions.claimTask = () =>
        claimNextKuaishouDramaTaskApi({
          ...apiOptions,
          runtimeOptions,
        });
      runtimeOptions.reportTaskSuccess = (task: Record<string, unknown>) =>
        reportKuaishouDramaTaskSuccessApi({ ...apiOptions, ...task } as unknown as {
          apiConfig: { baseUrl: string };
          accountTaskId: number;
          resultJson?: Record<string, unknown>;
        });
      runtimeOptions.reportTaskError = (task: Record<string, unknown>) =>
        reportKuaishouDramaTaskErrorApi({ ...apiOptions, ...task } as unknown as {
          apiConfig: { baseUrl: string };
          accountTaskId: number;
          failStage: string;
          errorMessage: string;
        });
      const runtime = await startKuaishouDramaRuntime(runtimeOptions);
      accountRuntimes.push({ account, runtime });
    }
  } catch (error) {
    await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop()));
    throw error;
  }

  return {
    getStatus: () => ({
      platform: "kuaishou-drama" as const,
      running: running && accountRuntimes.some(({ runtime }) => runtime.getStatus().running),
      accounts: accountRuntimes.map(({ account, runtime }) => ({
        ...runtime.getStatus(),
        accountId: account.accountId,
        accountName: account.accountName,
        loginAccount: account.loginAccount,
        launched: runtime.getStatus().running,
      })),
    }),
    stop: async () => {
      running = false;
      await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop()));
    },
  };
}

export function registerKuaishouDramaPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "kuaishou-drama",
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: "/dramaAiRpa/kuaishou",
  });
  registerKuaishouRuntimeAssetCleanup();
  ipcMain.handle("kuaishou-drama:config:get", () => ({
    config: readConfig(),
    path: configPath(),
    storagePaths: storagePaths(),
    restartRequired: false,
  }));

  ipcMain.handle(
    "kuaishou-drama:config:save",
    (_event, config: KuaishouDramaConfig): KuaishouDramaConfigResult => {
      const nextConfig = normalizeConfig(config);
      writeConfig(nextConfig);
      registerKuaishouRuntimeAssetCleanup(readConfig());
      return {
        config: nextConfig,
        path: configPath(),
        storagePaths: storagePaths(nextConfig),
        restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
      };
    },
  );

  ipcMain.handle(
    "kuaishou-drama:config:select-run-data-dir",
    async (event, currentPath?: string) => {
      const selectedPath = await selectDirectory(event, {
        title: "选择快手短剧运行数据目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
        properties: ["openDirectory", "createDirectory"],
      });

      return normalizePlatformRunDataDir(selectedPath, "kuaishou-drama");
    },
  );

  ipcMain.handle(
    "kuaishou-drama:config:select-local-episode-video-root",
    async (event, currentPath?: string) =>
      selectDirectory(event, {
        title: "选择快手短剧剧集视频根目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
        properties: ["openDirectory", "createDirectory"],
      }),
  );

  ipcMain.handle(
    "kuaishou-drama:config:open-storage-path",
    async (_event, key: keyof KuaishouDramaStoragePaths | "configFilePath" | "latestLog") => {
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

  ipcMain.handle("kuaishou-drama:service:status", () => status());

  ipcMain.handle("kuaishou-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) {
      await runtimeController.stop();
    }

    await runtimeController.start(startRuntime);
    return status();
  });

  ipcMain.handle("kuaishou-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopKuaishouDramaPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopKuaishouDramaPlatformService() {
  return runtimeController.stop();
}
