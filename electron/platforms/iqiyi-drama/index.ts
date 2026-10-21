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
import { registerRuntimeAssetCleanupRoot } from "../../runtime-asset-cleanup";
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from "../baidu-netdisk";
import {
  directoryDefaultPath,
  ensureDirectories,
  findLatestFile,
  normalizePlatformRunDataDir,
  numberText,
  openExistingPath,
  openPathOrParent,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "../shared";

type IqiyiDramaLoginState = "login-required" | "logged-in" | "unknown";

type IqiyiDramaAccount = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};

type IqiyiDramaAccountRuntimeStatus = {
  platform: "iqiyi-drama";
  running: boolean;
  loginState: IqiyiDramaLoginState;
  activeUrl?: string;
  shortDramaCreateUrl: string;
  comicDramaCreateUrl: string;
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
    dramaType?: "short-drama" | "comic-drama";
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

type IqiyiDramaAccountRuntime = {
  getStatus: () => IqiyiDramaAccountRuntimeStatus;
  stop: () => Promise<void>;
};

type IqiyiDramaRuntimeStatus = {
  platform: "iqiyi-drama";
  running: boolean;
  shortDramaCreateUrl: string;
  comicDramaCreateUrl: string;
  loginUrl: string;
  accounts: Array<IqiyiDramaAccountRuntimeStatus & {
    accountId: string;
    accountName: string;
    loginAccount?: string | null;
    launched: boolean;
  }>;
};

type IqiyiDramaRuntime = {
  getStatus: () => IqiyiDramaRuntimeStatus;
  stop: () => Promise<void>;
};

export type IqiyiDramaConfig = {
  accountProfileName: string;
  apiBaseUrl: string;
  localMaterialRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
  headless: string;
  operationDelaySeconds: string;
  taskPollIntervalSeconds: string;
  closeFailedTaskPages: string;
  runDataDir: string;
  logRetentionDays: string;
};

type IqiyiDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type IqiyiDramaServiceStatus = IqiyiDramaRuntimeStatus & { pid: number | null };

type IqiyiDramaStore = {
  config: Partial<IqiyiDramaConfig> & Record<string, string | undefined>;
};

const shortDramaCreateUrl = "https://creator.iqiyi.com/miniPlay/project/create";
const comicDramaCreateUrl = "https://creator.iqiyi.com/comicPlay/project/create";
const loginUrl =
  "https://creator.iqiyi.com/?from=https%3A%2F%2Fcreator.iqiyi.com%2FcomicPlay%2Fproject%2Fcreate&showLogin=1";
const defaultConfig: IqiyiDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localMaterialRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  closeFailedTaskPages: "false",
  runDataDir: "D:\\.drama-runs\\iqiyi-drama",
  logRetentionDays: "3",
};

const runtimeController = new RuntimeController<IqiyiDramaRuntime>();
let store: Store<IqiyiDramaStore> | null = null;

export function getIqiyiDramaBrowserInstanceCount() {
  return runtimeController.current?.getStatus().accounts.filter((account) => account.launched).length ?? 0;
}

export function getIqiyiDramaRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getIqiyiDramaPlatformRuntimeSummary() {
  const status = runtimeController.current?.getStatus();
  const paths = storagePaths();
  return {
    platform: "iqiyi-drama" as const,
    running: Boolean(status?.running),
    startedAt: runtimeController.startedAt,
    browserInstanceCount: status?.accounts.filter((account) => account.launched).length ?? 0,
    browserInstances: status?.accounts.filter((account) => account.launched).map((account) => ({
      id: account.accountId,
      label: account.accountName,
      loginState: account.loginState,
      activeUrl: account.activeUrl,
    })) ?? [],
    logDir: paths.logDir,
  };
}

export function openIqiyiDramaLogDir() {
  const dir = storagePaths().logDir;
  ensureDirectories([dir]);
  return openExistingPath(dir);
}

function getStore() {
  store ??= createValidatedStore<IqiyiDramaStore>({
    name: "iqiyi-drama-config",
    defaults: { config: defaultConfig },
  });
  return store;
}

function normalizeConfig(
  config: Partial<IqiyiDramaConfig> & Record<string, string | undefined>,
): IqiyiDramaConfig {
  return {
    accountProfileName: config.accountProfileName?.trim() || defaultConfig.accountProfileName,
    apiBaseUrl: config.apiBaseUrl?.trim() || defaultConfig.apiBaseUrl,
    localMaterialRoot: config.localMaterialRoot ?? defaultConfig.localMaterialRoot,
    baiduNetdiskDownloadRetryAttempts: numberText(
      config.baiduNetdiskDownloadRetryAttempts,
      defaultConfig.baiduNetdiskDownloadRetryAttempts,
    ),
    headless: config.headless ?? defaultConfig.headless,
    operationDelaySeconds: numberText(
      config.operationDelaySeconds,
      defaultConfig.operationDelaySeconds,
    ),
    taskPollIntervalSeconds: numberText(
      config.taskPollIntervalSeconds,
      defaultConfig.taskPollIntervalSeconds,
      1,
    ),
    closeFailedTaskPages:
      config.closeFailedTaskPages ?? defaultConfig.closeFailedTaskPages,
    runDataDir: !config.runDataDir
      || config.runDataDir === ".drama-runs"
      || config.runDataDir === ".drama-runs/iqiyi-drama"
      ? defaultConfig.runDataDir
      : config.runDataDir,
    logRetentionDays: numberText(config.logRetentionDays, defaultConfig.logRetentionDays, 1),
  };
}

function readConfig() {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("iqiyi-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localMaterialRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localMaterialRoot: directories.localMaterialRoot,
  };
}

function runDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function encodedProfile(config = readConfig(), profile = config.accountProfileName) {
  return encodeURIComponent(profile.trim() || "default");
}

function accountDir(config = readConfig(), profile = config.accountProfileName) {
  return path.join(runDataDir(config), "auth", "accounts", encodedProfile(config, profile));
}

function userDataDir(config = readConfig(), profile = config.accountProfileName) {
  return path.join(accountDir(config, profile), "chromium-profile");
}

function credentialStatePath(config = readConfig(), profile = config.accountProfileName) {
  return path.join(accountDir(config, profile), "storage-state.json");
}

function assetDownloadDir(config = readConfig(), profile = config.accountProfileName) {
  return path.join(runDataDir(config), "assets", encodedProfile(config, profile));
}

function logDir(config = readConfig()) {
  return path.join(runDataDir(config), "logs");
}

function dateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function storagePaths(
  config = readConfig(),
  profile = config.accountProfileName,
): IqiyiDramaStoragePaths {
  return {
    runDataDir: runDataDir(config),
    accountDir: accountDir(config, profile),
    userDataDir: userDataDir(config, profile),
    credentialStatePath: credentialStatePath(config, profile),
    assetDownloadDir: assetDownloadDir(config, profile),
    logDir: logDir(config),
    logFilePath: path.join(logDir(config), `app-${dateKey()}.log`),
  };
}

function registerIqiyiRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: "iqiyi-drama",
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

function latestLog(paths = storagePaths()) {
  return findLatestFile(
    paths.logDir,
    (fileName) => /^app(?:-.+)?-\d{4}-\d{2}-\d{2}\.(?:log|jsonl)$/i.test(fileName),
  );
}

async function importRuntimePackage() {
  return import("@dramabridge/iqiyi-drama-automation") as Promise<{
    fetchIqiyiDramaAccounts: (
      apiBaseUrl: string,
      fetcher?: typeof fetch,
    ) => Promise<IqiyiDramaAccount[]>;
    startIqiyiDramaRuntime: (
      options: Record<string, unknown>,
    ) => Promise<IqiyiDramaAccountRuntime>;
  }>;
}

function stoppedStatus(): IqiyiDramaServiceStatus {
  return {
    platform: "iqiyi-drama",
    running: false,
    shortDramaCreateUrl,
    comicDramaCreateUrl,
    loginUrl,
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<IqiyiDramaServiceStatus> {
  const runtime = runtimeController.current;
  if (!runtime) return stoppedStatus();
  const current = runtime.getStatus();
  if (!current.running) {
    await runtimeController.stop();
    return stoppedStatus();
  }
  return { ...current, pid: process.pid };
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const {
    fetchIqiyiDramaAccounts,
    startIqiyiDramaRuntime,
  } = await importRuntimePackage();
  const accounts = await fetchIqiyiDramaAccounts(config.apiBaseUrl);
  if (accounts.length === 0) throw new Error("IQIYI_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");

  const aiClient = createConfiguredAiClient();
  const aiImageModel = getConfiguredAiImageModel();
  const runtimes: Array<{ account: IqiyiDramaAccount; runtime: IqiyiDramaAccountRuntime }> = [];
  let running = true;
  try {
    for (const account of accounts) {
      const paths = storagePaths(config, account.accountId);
      ensureStorageDirectories(paths);
      const runtime = await startIqiyiDramaRuntime({
        accountProfileName: account.accountId,
        iqiyiAccountId: account.accountId,
        iqiyiAccountName: account.accountName,
        accountDir: paths.accountDir,
        userDataDir: paths.userDataDir,
        credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir,
        logFilePath: paths.logFilePath,
        logRetentionDays: Math.max(1, Number.parseInt(config.logRetentionDays, 10) || 3),
        localMaterialRoot: config.localMaterialRoot,
        baiduNetdiskDownloadRetryAttempts: Math.max(
          0,
          Number.parseInt(config.baiduNetdiskDownloadRetryAttempts, 10) || 0,
        ),
        taskPollIntervalMs: Math.max(
          1,
          Number.parseFloat(config.taskPollIntervalSeconds) || 10,
        ) * 1000,
        closeFailedTaskPages: config.closeFailedTaskPages === "true",
        aiClient,
        aiImageModel,
        aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        ensureBaiduNetdiskResource: (request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0]) => ensureBaiduNetdiskShareDownloaded({
          ...request,
          requesterPlatform: "iqiyi-drama",
        }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        apiConfig: { baseUrl: config.apiBaseUrl },
        config: {
          browser: {
            headless: config.headless === "true",
            slowMo: Math.max(0, Number.parseFloat(config.operationDelaySeconds) || 0) * 1000,
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
    getStatus(): IqiyiDramaRuntimeStatus {
      const runtimeAccounts = runtimes.map(({ account, runtime }) => {
        const current = runtime.getStatus();
        return {
          ...current,
          accountId: account.accountId,
          accountName: account.accountName,
          loginAccount: account.loginAccount,
          launched: current.running,
        };
      });
      if (runtimeAccounts.every((account) => !account.launched)) running = false;
      return {
        platform: "iqiyi-drama",
        running,
        shortDramaCreateUrl,
        comicDramaCreateUrl,
        loginUrl,
        accounts: runtimeAccounts,
      };
    },
    async stop() {
      running = false;
      await Promise.allSettled(runtimes.map(({ runtime }) => runtime.stop()));
    },
  };
}

export function registerIqiyiDramaPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "iqiyi-drama",
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: "/dramaAiRpa/iqiyi",
  });
  registerIqiyiRuntimeAssetCleanup();
  ipcMain.handle("iqiyi-drama:config:get", () => ({
    config: readConfig(),
    path: getStore().path,
    storagePaths: storagePaths(),
    restartRequired: false,
  }));
  ipcMain.handle("iqiyi-drama:config:save", (_event, config: IqiyiDramaConfig) => {
    const next = normalizeConfig(config);
    getStore().set("config", next);
    registerIqiyiRuntimeAssetCleanup(readConfig());
    return {
      config: next,
      path: getStore().path,
      storagePaths: storagePaths(next),
      restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
    };
  });
  ipcMain.handle("iqiyi-drama:config:select-run-data-dir", async (event, current?: string) => {
    const selected = await selectDirectory(event, {
      title: "选择爱奇艺运行数据目录",
      defaultPath: directoryDefaultPath(current, app.getPath("documents")),
      properties: ["openDirectory", "createDirectory"],
    });
    return normalizePlatformRunDataDir(selected, "iqiyi-drama");
  });
  ipcMain.handle("iqiyi-drama:config:select-local-material-root", (event, current?: string) =>
    selectDirectory(event, {
      title: "选择爱奇艺封面与权属素材根目录",
      defaultPath: directoryDefaultPath(current, app.getPath("pictures")),
      properties: ["openDirectory", "createDirectory"],
    })
  );
  ipcMain.handle(
    "iqiyi-drama:config:open-storage-path",
    (_event, key: keyof IqiyiDramaStoragePaths | "configFilePath" | "latestLog") => {
      const paths = storagePaths();
      ensureStorageDirectories(paths);
      if (key === "configFilePath") return openPathOrParent(getStore().path);
      if (key === "latestLog") return openExistingPath(latestLog(paths));
      if (key === "credentialStatePath" || key === "logFilePath") {
        return openPathOrParent(paths[key]);
      }
      return openExistingPath(paths[key]);
    },
  );
  ipcMain.handle("iqiyi-drama:service:status", () => status());
  ipcMain.handle("iqiyi-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) await runtimeController.stop();
    await runtimeController.start(startRuntime);
    return status();
  });
  ipcMain.handle("iqiyi-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopIqiyiDramaPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopIqiyiDramaPlatformService() {
  return runtimeController.stop();
}
