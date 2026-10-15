import { app, ipcMain } from "electron";
import Store from "electron-store";
import { registerTaskAnalyticsHandler } from "./task-analytics";
import cron, { type ScheduledTask } from "node-cron";
import { mkdirSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
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
import {
  assertGlobalDirectoriesConfigured,
  resolveGlobalPlatformDirectories,
} from "../global-app-config";

type MeituanCreationRuntimeStatus = {
  platform: "meituan-drama";
  loginUrl: string;
  publishVideoUrl: string;
  running: boolean;
  accounts: Array<{
    accountId: string;
    accountName: string;
    loginAccount?: string | null;
    launched: boolean;
    loginState: "login-required" | "logged-in" | "unknown";
    activeUrl?: string;
    userDataDir: string;
  }>;
};

type MeituanCreationRuntime = {
  getStatus: () => MeituanCreationRuntimeStatus;
  stop: () => Promise<void>;
};

export type MeituanCreationConfig = {
  apiBaseUrl: string;
  headless: string;
  operationDelaySeconds: string;
  episodeUploadFailedRetryAttempts: string;
  closeTaskPageAfterRun: string;
  localEpisodeVideoRoot: string;
  runDataDir: string;
};

export type MeituanCreationServiceStatus = MeituanCreationRuntimeStatus & {
  pid: number | null;
};

type MeituanCreationConfigResult = {
  config: MeituanCreationConfig;
  path: string;
  restartRequired: boolean;
};

type MeituanCreationStore = {
  config: Partial<MeituanCreationConfig> & Record<string, string | undefined>;
};

const defaultMeituanCreationConfig: MeituanCreationConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  headless: "false",
  operationDelaySeconds: "0.02",
  episodeUploadFailedRetryAttempts: "5",
  closeTaskPageAfterRun: "true",
  localEpisodeVideoRoot: "",
  runDataDir: ".drama-runs/meituan-drama",
};

const runtimeController = new RuntimeController<MeituanCreationRuntime>();
let store: Store<MeituanCreationStore> | null = null;
let contractCleanupTask: ScheduledTask | null = null;

export function getMeituanCreationBrowserInstanceCount() {
  return (
    runtimeController.current
      ?.getStatus()
      .accounts.filter((account) => account.launched).length ?? 0
  );
}

export function getMeituanCreationRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getMeituanCreationPlatformRuntimeSummary() {
  const runtimeStatus = runtimeController.current?.getStatus();
  const running = Boolean(runtimeStatus?.running);

  return {
    platform: "meituan-drama" as const,
    running,
    browserInstanceCount:
      runtimeStatus?.accounts.filter((account) => account.launched).length ?? 0,
    browserInstances: runtimeStatus?.accounts
      .filter((account) => account.launched)
      .map((account) => ({
        id: account.accountId,
        label: account.accountName,
        loginState: account.loginState,
        activeUrl: account.activeUrl,
      })) ?? [],
    logDir: meituanCreationLogDir(),
  };
}

export function openMeituanCreationLogDir() {
  const logDir = meituanCreationLogDir();
  mkdirSync(logDir, { recursive: true });
  return openExistingPath(logDir);
}

function getStore() {
  if (!store) {
    store = new Store<MeituanCreationStore>({
      name: "meituan-drama-config",
      defaults: {
        config: defaultMeituanCreationConfig,
      },
    });
  }

  return store;
}

function normalizeConfig(
  config: Partial<MeituanCreationConfig> & Record<string, string | undefined>,
) {
  const legacySlowMo = Number.parseFloat(config.slowMo ?? "");
  const operationDelaySeconds =
    config.operationDelaySeconds ??
    (Number.isFinite(legacySlowMo) ? String(legacySlowMo / 1000) : undefined) ??
    defaultMeituanCreationConfig.operationDelaySeconds;
  const retryAttempts = Number.parseInt(config.episodeUploadFailedRetryAttempts ?? "", 10);
  return {
    apiBaseUrl: config.apiBaseUrl?.trim() || defaultMeituanCreationConfig.apiBaseUrl,
    headless: config.headless ?? defaultMeituanCreationConfig.headless,
    operationDelaySeconds,
    episodeUploadFailedRetryAttempts:
      Number.isInteger(retryAttempts) && retryAttempts >= 0
        ? String(retryAttempts)
        : defaultMeituanCreationConfig.episodeUploadFailedRetryAttempts,
    closeTaskPageAfterRun:
      config.closeTaskPageAfterRun ?? defaultMeituanCreationConfig.closeTaskPageAfterRun,
    localEpisodeVideoRoot:
      config.localEpisodeVideoRoot ?? defaultMeituanCreationConfig.localEpisodeVideoRoot,
    runDataDir:
      !config.runDataDir || config.runDataDir === ".drama-runs"
        ? defaultMeituanCreationConfig.runDataDir
        : config.runDataDir,
  };
}

function readConfig(): MeituanCreationConfig {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("meituan-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function writeConfig(config: MeituanCreationConfig) {
  getStore().set("config", config);
}

function configPath() {
  return getStore().path;
}

async function defaultStoppedStatus(): Promise<MeituanCreationServiceStatus> {
  return {
    platform: "meituan-drama",
    loginUrl: "https://czz.meituan.com/new/login",
    publishVideoUrl: "https://czz.meituan.com/new/publishVideo",
    running: false,
    accounts: [],
    pid: null,
  };
}

async function status(): Promise<MeituanCreationServiceStatus> {
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

function meituanCreationRunDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function meituanCreationLogDir(config = readConfig()) {
  return path.join(meituanCreationRunDataDir(config), "logs");
}

function meituanPlatformLogger(scope = "runtime") {
  return createElectronPlatformLogger({
    platform: "meituan-drama",
    scope,
    logDir: meituanCreationLogDir(),
    retentionDays: 3,
  });
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function meituanCreationLogFile(config = readConfig()) {
  return path.join(meituanCreationLogDir(config), `app-${formatDateKey()}.log`);
}

function meituanCreationAuthRoot() {
  return path.join(meituanCreationRunDataDir(), "auth");
}

function meituanCreationAssetDownloadRoot() {
  return path.join(meituanCreationRunDataDir(), "remote-upload-assets");
}

function meituanCreationCopyrightProofRoot(accountDir: string) {
  return path.join(accountDir, "copyright-proofs");
}

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function latestModifiedAtMs(target: string): Promise<number> {
  const targetStat = await lstat(target);
  let latest = targetStat.mtimeMs;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return latest;

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(target, entry.name);
    latest = Math.max(latest, await latestModifiedAtMs(entryPath));
  }
  return latest;
}

async function cleanupPreviousMeituanCopyrightProofs(now = new Date()) {
  const assetRoot = path.resolve(meituanCreationAssetDownloadRoot());
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let accountEntries;
  try {
    accountEntries = await readdir(assetRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  let deletedCount = 0;
  for (const accountEntry of accountEntries) {
    if (!accountEntry.isDirectory() || accountEntry.isSymbolicLink()) continue;
    const accountDir = path.join(assetRoot, accountEntry.name);
    const proofRoot = meituanCreationCopyrightProofRoot(accountDir);
    const taskEntries = await readdir(proofRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissingPathError(error)) return [];
      throw error;
    });
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink()) continue;
      const taskDir = path.resolve(proofRoot, taskEntry.name);
      const relativeTaskDir = path.relative(proofRoot, taskDir);
      if (!relativeTaskDir || relativeTaskDir.startsWith("..") || path.isAbsolute(relativeTaskDir)) {
        continue;
      }

      const modifiedAtMs = await latestModifiedAtMs(taskDir).catch((error: unknown) => {
        if (isMissingPathError(error)) return startOfToday;
        throw error;
      });
      if (modifiedAtMs >= startOfToday) continue;

      await rm(taskDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 500,
      });
      deletedCount += 1;
      meituanPlatformLogger("storage").info("Deleted expired copyright materials", { path: taskDir });
    }
  }

  meituanPlatformLogger("storage").info("Expired copyright materials cleanup completed", { deletedCount });
}

function scheduleMeituanCopyrightProofCleanup() {
  if (contractCleanupTask) return;
  contractCleanupTask = cron.schedule("0 1 * * *", async () => {
    await cleanupPreviousMeituanCopyrightProofs().catch((error: unknown) => {
      meituanPlatformLogger("storage").error("Expired copyright materials cleanup failed", { error });
    });
  }, {
    name: "meituan-copyright-proof-cleanup",
    timezone: "Asia/Shanghai",
    noOverlap: true,
    unref: true,
  });
  meituanPlatformLogger("storage").info("Copyright materials scheduled cleanup enabled", {
    schedule: "daily at 01:00",
  });
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();

  const config = readConfig();
  const operationDelayMs = Math.max(0, Number.parseFloat(config.operationDelaySeconds) || 0) * 1000;
  const episodeUploadFailedRetryAttempts = Math.max(
    0,
    Number.parseInt(config.episodeUploadFailedRetryAttempts, 10) || 0,
  );
  const {
    fetchMeituanCreationAccounts,
    startMeituanCreationRuntime,
  } = await import("@drama/meituan-drama-automation");
  const accounts = await fetchMeituanCreationAccounts(config.apiBaseUrl);
  meituanPlatformLogger("account").info("Loaded enabled accounts", {
    count: accounts.length,
    accounts: accounts.map((account) => ({ id: account.accountId, name: account.accountName })),
  });
  return startMeituanCreationRuntime({
    accounts,
    apiBaseUrl: config.apiBaseUrl,
    authRoot: meituanCreationAuthRoot(),
    assetDownloadRoot: meituanCreationAssetDownloadRoot(),
    logFilePath: meituanCreationLogFile(config),
    logRetentionDays: 3,
    episodeUploadFailedRetryAttempts,
    closeTaskPageAfterRun: config.closeTaskPageAfterRun === "true",
    ensureBaiduNetdiskResource: (request) => ensureBaiduNetdiskShareDownloaded({
      ...request,
      requesterPlatform: "meituan-drama",
    }),
    cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
    config: {
      localEpisodeVideoRoot: config.localEpisodeVideoRoot,
      browser: {
        headless: config.headless === "true",
        slowMo: operationDelayMs,
      },
    },
  });
}

export function registerMeituanCreationPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "meituan-drama",
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: "/dramaAiRpa/meituan",
  });
  scheduleMeituanCopyrightProofCleanup();

  ipcMain.handle("meituan-drama:config:get", () => ({
    config: readConfig(),
    path: configPath(),
    restartRequired: false,
  }));

  ipcMain.handle(
    "meituan-drama:config:save",
    (_event, config: MeituanCreationConfig): MeituanCreationConfigResult => {
      const nextConfig = normalizeConfig(config);
      writeConfig(nextConfig);
      return {
        config: nextConfig,
        path: configPath(),
        restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
      };
    },
  );

  ipcMain.handle(
    "meituan-drama:config:select-local-episode-video-root",
    async (event, currentPath?: string) => {
      return selectDirectory(event, {
        title: "选择美团剧集视频目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
        properties: ["openDirectory", "createDirectory"],
      });
    },
  );

  ipcMain.handle(
    "meituan-drama:config:select-run-data-dir",
    async (event, currentPath?: string) => {
      const selectedPath = await selectDirectory(event, {
        title: "选择美团创作平台运行数据目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
        properties: ["openDirectory", "createDirectory"],
      });

      return normalizePlatformRunDataDir(selectedPath, "meituan-drama");
    },
  );

  ipcMain.handle("meituan-drama:service:status", () => status());

  ipcMain.handle("meituan-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) {
      await runtimeController.stop();
    }

    await runtimeController.start(startRuntime);
    return status();
  });

  ipcMain.handle("meituan-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopMeituanCreationPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopMeituanCreationPlatformService() {
  return runtimeController.stop();
}
