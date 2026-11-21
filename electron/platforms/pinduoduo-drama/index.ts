import { app, BrowserWindow } from "electron";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import { registerTaskAnalyticsHandler } from "../shared/task-analytics";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupBaiduNetdiskPlayletAfterTaskSuccess,
  ensureBaiduNetdiskShareDownloaded,
  type BaiduNetdiskEnsureDownloadedRequest,
} from "../baidu-netdisk";
import {
  configureNativeChildWindow,
  directoryDefaultPath,
  ensureDirectories,
  findLatestFile,
  normalizePlatformRunDataDir,
  openExistingPath,
  openPathOrParent,
  platformWindowIconPath,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "../shared";
import { configuredFeishuTables, readFeishuSettings, lockFeishuSettings } from "../../integrations/feishu";
import { PinduoduoFeishuTables, selectPinduoduoAccounts, type PinduoduoFeishuAccount } from "./feishu";
import { PinduoduoSourceTable, validatePinduoduoSourceUrl } from "./source-table";
import { PINDUODUO_DEFAULT_SOURCE_TABLE_URL } from "../../../src/platforms/pinduoduo-drama/defaults";
type ListUploadRecordsFilter = { status?: string; limit?: number; offset?: number };
type RuntimeInstance = { id: string; name: string; launched: boolean; loginState: string; activeUrl?: string; uploadProgress?: import("@dramabridge/pinduoduo-drama-automation").PinduoduoUploadProgress };
import {
  assertGlobalDirectoriesConfigured,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadRecordsWindowMode = "pinduoduo-drama-upload-records";
const uploadRecordsWindowTitle = "拼多多审核与上传状态";

type PinduoduoDramaRuntimeStatus = {
  uploadProgress?: import("@dramabridge/pinduoduo-drama-automation").PinduoduoUploadProgress;
  lastError?: string;
  platform: "pinduoduo-drama";
  running: boolean;
  loginState: "login-required" | "logged-in" | "unknown";
  activeUrl?: string;
  manageUrl: string;
  loginExpiredUrl: string;
  userDataDir: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  logFilePath?: string;
  instances?: RuntimeInstance[];
  accountErrors?: Record<string, string>;
};

type PinduoduoDramaRuntime = {
  getStatus: () => PinduoduoDramaRuntimeStatus;
  stop: () => Promise<void>;
};

export type PinduoduoDramaConfig = {
  sourceTableUrl: string;
  accountProfileName: string;
  creatorName: string;
  browserExecutablePath: string;
  headless: string;
  runDataDir: string;
  logRetentionDays: string;
  taskPollIntervalMinutes: string;
  videoUploadTimeoutMinutes: string;
  localEpisodeVideoRoot: string;
  baiduNetdiskDownloadRetryAttempts: string;
};

export type PinduoduoDramaServiceStatus = PinduoduoDramaRuntimeStatus & {
  pid: number | null;
};

type PinduoduoDramaConfigResult = {
  config: PinduoduoDramaConfig;
  path: string;
  storagePaths: PinduoduoDramaStoragePaths;
  restartRequired: boolean;
};

type PinduoduoDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  logDir: string;
  logFilePath: string;
};

type PinduoduoDramaStore = {
  selectedAccountIds: string[];
  config: Partial<PinduoduoDramaConfig> & Record<string, string | undefined>;
};

function defaultPinduoduoBrowserExecutablePath() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "";
}

const defaultPinduoduoDramaConfig: PinduoduoDramaConfig = {
  sourceTableUrl: PINDUODUO_DEFAULT_SOURCE_TABLE_URL,
  accountProfileName: "default",
  creatorName: "",
  browserExecutablePath: defaultPinduoduoBrowserExecutablePath(),
  headless: "false",
  runDataDir: ".drama-runs/pinduoduo-drama",
  logRetentionDays: "3",
  taskPollIntervalMinutes: "120",
  videoUploadTimeoutMinutes: "60",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
};

const runtimeController = new RuntimeController<PinduoduoDramaRuntime>();
let store: Store<PinduoduoDramaStore> | null = null;
let feishuSession: PinduoduoFeishuTables | undefined;
let uploadRecordsWindow: BrowserWindow | null = null;

function openUploadRecordsWindow() {
  if (uploadRecordsWindow && !uploadRecordsWindow.isDestroyed()) {
    uploadRecordsWindow.show();
    uploadRecordsWindow.focus();
    return;
  }

  const nextWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: uploadRecordsWindowTitle,
    icon: platformWindowIconPath("pdd.png"),
    autoHideMenuBar: true,
    backgroundColor: "#fafafa",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      sandbox: false,
    },
  });
  uploadRecordsWindow = nextWindow;
  configureNativeChildWindow(nextWindow, uploadRecordsWindowTitle);
  nextWindow.once("ready-to-show", () => nextWindow.show());
  nextWindow.on("closed", () => {
    if (uploadRecordsWindow === nextWindow) uploadRecordsWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    url.searchParams.set("window", uploadRecordsWindowMode);
    void nextWindow.loadURL(url.toString());
  } else {
    void nextWindow.loadFile(
      path.join(process.env.APP_ROOT ?? path.join(__dirname, "..", ".."), "dist", "index.html"),
      { query: { window: uploadRecordsWindowMode } },
    );
  }
}

function getUploadRecordsRepository() {
  if (feishuSession) return feishuSession;
  const url = readFeishuSettings().tableUrl;
  if (!url) throw new Error("请先在全局配置中设置飞书表格连接");
  return new PinduoduoFeishuTables(configuredFeishuTables(), url, readConfig().sourceTableUrl);
}

export function getPinduoduoDramaBrowserInstanceCount() {
  return runtimeController.current?.getStatus().instances?.filter(item => item.launched).length ?? 0;
}

export function getPinduoduoDramaRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getPinduoduoDramaPlatformRuntimeSummary() {
  const runtimeStatus = runtimeController.current?.getStatus();
  const running = Boolean(runtimeStatus?.running);
  const paths = storagePaths();

  return {
    platform: "pinduoduo-drama" as const,
    running,
    startedAt: runtimeController.startedAt,
    browserInstanceCount: runtimeStatus?.instances?.filter(item => item.launched).length ?? 0,
    browserInstances: (runtimeStatus?.instances ?? []).filter(item => item.launched).map(item => ({
      id: item.id, label: item.name, loginState: item.loginState as "unknown" | "logged-in" | "login-required", activeUrl: item.activeUrl,
    })),
    logDir: paths.logDir,
  };
}

export function openPinduoduoDramaLogDir() {
  const paths = storagePaths();
  ensureDirectories([paths.logDir]);
  return openExistingPath(paths.logDir);
}

function getStore() {
  if (!store) {
    store = createValidatedStore<PinduoduoDramaStore>({
      name: "pinduoduo-drama-config",
      defaults: {
        selectedAccountIds: [],
        config: defaultPinduoduoDramaConfig,
      },
    });
  }

  return store;
}

function normalizePositiveInteger(value: string | undefined, fallback: string, min: number) {
  const nextValue = value?.trim();
  if (!nextValue) {
    return fallback;
  }

  const numericValue = Number.parseInt(nextValue, 10);
  if (!Number.isFinite(numericValue) || numericValue < min) {
    if (numericValue === 0) {
      return "0";
    }
    return fallback;
  }

  return String(numericValue);
}

function normalizeConfig(
  config: Partial<PinduoduoDramaConfig> & Record<string, string | undefined>,
): PinduoduoDramaConfig {
  return {
    sourceTableUrl: config.sourceTableUrl?.trim() || defaultPinduoduoDramaConfig.sourceTableUrl,
    accountProfileName:
      config.accountProfileName?.trim() || defaultPinduoduoDramaConfig.accountProfileName,
    creatorName: config.creatorName?.trim() || defaultPinduoduoDramaConfig.creatorName,
    browserExecutablePath:
      config.browserExecutablePath?.trim() ?? defaultPinduoduoDramaConfig.browserExecutablePath,
    headless: config.headless ?? defaultPinduoduoDramaConfig.headless,
    runDataDir:
      !config.runDataDir || config.runDataDir === ".drama-runs"
        ? defaultPinduoduoDramaConfig.runDataDir
        : config.runDataDir,
    logRetentionDays: config.logRetentionDays ?? defaultPinduoduoDramaConfig.logRetentionDays,
    taskPollIntervalMinutes: normalizePositiveInteger(
      config.taskPollIntervalMinutes,
      defaultPinduoduoDramaConfig.taskPollIntervalMinutes,
      1,
    ),
    videoUploadTimeoutMinutes: normalizePositiveInteger(
      config.videoUploadTimeoutMinutes,
      defaultPinduoduoDramaConfig.videoUploadTimeoutMinutes,
      1,
    ),
    localEpisodeVideoRoot:
      config.localEpisodeVideoRoot ?? defaultPinduoduoDramaConfig.localEpisodeVideoRoot,
    baiduNetdiskDownloadRetryAttempts: normalizePositiveInteger(
      config.baiduNetdiskDownloadRetryAttempts,
      defaultPinduoduoDramaConfig.baiduNetdiskDownloadRetryAttempts,
      0,
    ),
  };
}

function readConfig(): PinduoduoDramaConfig {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("pinduoduo-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function writeConfig(config: PinduoduoDramaConfig) {
  getStore().set("config", config);
}

function configPath() {
  return getStore().path;
}

function pinduoduoDramaRunDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function encodedAccountProfileName(config = readConfig()) {
  return encodeURIComponent(config.accountProfileName.trim() || "default");
}

function pinduoduoDramaAccountDir(config = readConfig()) {
  return path.join(
    pinduoduoDramaRunDataDir(config),
    "auth",
    "accounts",
    encodedAccountProfileName(config),
  );
}

function pinduoduoDramaUserDataDir(config = readConfig()) {
  return path.join(pinduoduoDramaAccountDir(config), "chromium-profile");
}

function pinduoduoDramaCredentialStatePath(config = readConfig()) {
  return path.join(pinduoduoDramaAccountDir(config), "storage-state.json");
}

function pinduoduoDramaLogDir(config = readConfig()) {
  return path.join(pinduoduoDramaRunDataDir(config), "logs");
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function pinduoduoDramaLogFile(config = readConfig()) {
  return path.join(pinduoduoDramaLogDir(config), `app-${formatDateKey()}.json`);
}

function storagePaths(config = readConfig()): PinduoduoDramaStoragePaths {
  return {
    runDataDir: pinduoduoDramaRunDataDir(config),
    accountDir: pinduoduoDramaAccountDir(config),
    userDataDir: pinduoduoDramaUserDataDir(config),
    credentialStatePath: pinduoduoDramaCredentialStatePath(config),
    logDir: pinduoduoDramaLogDir(config),
    logFilePath: pinduoduoDramaLogFile(config),
  };
}

function ensureStorageDirectories(paths = storagePaths()) {
  ensureDirectories([paths.runDataDir, paths.accountDir, paths.userDataDir, paths.logDir]);
}

function findLatestLogPath(paths = storagePaths()) {
  return findLatestFile(
    paths.logDir,
    (fileName) => /^app(?:-.+)?-\d{4}-\d{2}-\d{2}\.(?:log|jsonl)$/i.test(fileName),
  );
}

async function defaultStoppedStatus(): Promise<PinduoduoDramaServiceStatus> {
  const config = readConfig();
  const paths = storagePaths(config);
  return {
    platform: "pinduoduo-drama",
    running: false,
    loginState: "unknown",
    manageUrl: "https://mcn.pinduoduo.com/home/shortplayManage",
    loginExpiredUrl: "https://mcn.pinduoduo.com/register",
    userDataDir: paths.userDataDir,
    accountProfileName: config.accountProfileName,
    accountDir: paths.accountDir,
    credentialStatePath: paths.credentialStatePath,
    logFilePath: paths.logFilePath,
    pid: null,
  };
}

async function status(): Promise<PinduoduoDramaServiceStatus> {
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

async function startRuntime(selectedAccountIds: unknown): Promise<PinduoduoDramaRuntime> {
  if (!Array.isArray(selectedAccountIds) || !selectedAccountIds.length || selectedAccountIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("请勾选需要启动的拼多多账号");
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const cloud = getUploadRecordsRepository();
  lockFeishuSettings("pinduoduo-drama", true);
  const sessions: Array<{ account: PinduoduoFeishuAccount; runtime: PinduoduoDramaRuntime }> = [];
  const errors: Record<string, string> = {};
  try {
    await cloud.prepare();
    const accounts = selectPinduoduoAccounts(await cloud.accounts(), selectedAccountIds);
    feishuSession = cloud;
    const { startPinduoduoDramaRuntime } = await import("@dramabridge/pinduoduo-drama-automation");
    await Promise.all(accounts.map(async account => {
      try {
        // Stable phone identity keeps each account's login directory separate.
        const paths = storagePaths({ ...config, accountProfileName: account.phone });
        ensureStorageDirectories(paths);
        const runtime = await startPinduoduoDramaRuntime({
          accountProfileName: account.name,
          accountPhone: account.phone,
          accountDir: paths.accountDir,
          userDataDir: paths.userDataDir,
          credentialStatePath: paths.credentialStatePath,
          logFilePath: paths.logFilePath,
          logRetentionDays: Math.max(1, Number.parseInt(config.logRetentionDays, 10) || 3),
          uploadRecords: cloud.forAccount(account),
          shouldRun: () => cloud.available(account),
          ensureBaiduNetdiskResource: (request: BaiduNetdiskEnsureDownloadedRequest) => ensureBaiduNetdiskShareDownloaded({ ...request, requesterPlatform: "pinduoduo-drama" }),
          cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
          config: {
            creatorName: account.creatorName,
            browser: { executablePath: config.browserExecutablePath || undefined, headless: config.headless === "true" },
            taskPollIntervalMinutes: config.taskPollIntervalMinutes,
            video: {
              baiduNetdiskDownloadRetryAttempts: config.baiduNetdiskDownloadRetryAttempts,
              localEpisodeVideoRoot: config.localEpisodeVideoRoot,
              videoUploadTimeoutMinutes: config.videoUploadTimeoutMinutes,
            },
          },
        });
        sessions.push({ account, runtime });
      } catch (error) {
        errors[account.name] = error instanceof Error ? error.message : String(error);
      }
    }));
    if (!sessions.length) throw new Error(Object.values(errors).join("；"));
    getStore().set("selectedAccountIds", sessions.map(({ account }) => account.phone));
    return {
      getStatus() {
        const first = sessions[0]!.runtime.getStatus();
        const instances = sessions.map(({ account, runtime }) => {
          const state = runtime.getStatus();
          return { id: account.phone, name: `${account.name} · ${account.creatorName}`, launched: state.running, loginState: state.loginState, activeUrl: state.activeUrl, uploadProgress: state.uploadProgress };
        });
        const accountErrors = { ...errors };
        for (const session of sessions) {
          const error = session.runtime.getStatus().lastError;
          if (error) accountErrors[session.account.name] = error;
        }
        return { ...first, running: instances.some(item => item.launched), instances, accountErrors };
      },
      async stop() {
        try {
          const results = await Promise.allSettled(sessions.map(async ({ runtime }) => {
            await runtime.stop();
          }));
          const failed = results.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        } finally {
          lockFeishuSettings("pinduoduo-drama", false);
          feishuSession = undefined;
        }
      },
    };
  } catch (error) {
    await Promise.allSettled(sessions.map(item => item.runtime.stop()));
    feishuSession = undefined;
    lockFeishuSettings("pinduoduo-drama", false);
    throw error;
  }
}

export function registerPinduoduoDramaPlatformHandlers() {
  ipcMain.handle("pinduoduo-drama:config:test-source-table", async (_event, input: string) => {
    if (typeof input !== "string") throw new Error("来源表链接无效");
    const source = new PinduoduoSourceTable(configuredFeishuTables(), input.trim());
    const index = await source.read();
    return { sheetName: "拼多多-新剧", titleCount: index.size };
  });
  registerTaskAnalyticsHandler({
    platform: "pinduoduo-drama",
    apiPrefix: "/pinduoduoDramaRpa",
    accountIdField: "pinduoduoAccountId",
    statusField: "rpaStatus",
  });
  ipcMain.handle("pinduoduo-drama:config:get", () => ({
    config: readConfig(),
    path: configPath(),
    storagePaths: storagePaths(),
    restartRequired: false,
  }));

  ipcMain.handle(
    "pinduoduo-drama:config:save",
    (_event, config: PinduoduoDramaConfig): PinduoduoDramaConfigResult => {
      const nextConfig = normalizeConfig(config);
      validatePinduoduoSourceUrl(nextConfig.sourceTableUrl);
      writeConfig(nextConfig);
      return {
        config: nextConfig,
        path: configPath(),
        storagePaths: storagePaths(nextConfig),
        restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
      };
    },
  );

  ipcMain.handle(
    "pinduoduo-drama:config:test-browser-path",
    async (_event, executablePath: string) => {
      const { testPinduoduoBrowserExecutable } = await import("@dramabridge/pinduoduo-drama-automation");
      return testPinduoduoBrowserExecutable(executablePath);
    },
  );

  ipcMain.handle(
    "pinduoduo-drama:config:select-run-data-dir",
    async (event, currentPath?: string) => {
      const selectedPath = await selectDirectory(event, {
        title: "选择拼多多短剧运行数据目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
        properties: ["openDirectory", "createDirectory"],
      });

      return normalizePlatformRunDataDir(selectedPath, "pinduoduo-drama");
    },
  );

  ipcMain.handle(
    "pinduoduo-drama:config:select-local-episode-video-root",
    async (event, currentPath?: string) => {
      return selectDirectory(event, {
        title: "选择拼多多剧集视频根目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
        properties: ["openDirectory", "createDirectory"],
      });
    },
  );

  ipcMain.handle(
    "pinduoduo-drama:config:open-storage-path",
    async (_event, key: keyof PinduoduoDramaStoragePaths | "configFilePath" | "latestLog") => {
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

  ipcMain.handle("pinduoduo-drama:service:status", () => status());

  ipcMain.handle("pinduoduo-drama:accounts:list", async () => {
    const accounts = await getUploadRecordsRepository().accounts();
    return {
      accounts: accounts.map(account => ({ accountId: account.phone, accountName: account.name, loginAccount: account.creatorName, status: "ON" })),
      selectedAccountIds: getStore().get("selectedAccountIds", []).filter(id => accounts.some(account => account.phone === id)),
    };
  });

  ipcMain.handle("pinduoduo-drama:service:start", async (_event, selectedAccountIds: unknown) => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) {
      await runtimeController.stop();
    }

    await runtimeController.start(() => startRuntime(selectedAccountIds));
    return status();
  });

  ipcMain.handle("pinduoduo-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });

  ipcMain.handle(
    "pinduoduo-drama:upload-records:list",
    async (_event, filter?: ListUploadRecordsFilter) => {
      const records = await getUploadRecordsRepository().list();
      const statuses = filter?.status?.split(",");
      const selected = records.filter(record => !statuses || statuses.includes(record.status));
      const limit = Math.min(500, Math.max(1, Number(filter?.limit) || 200));
      const offset = Math.max(0, Number(filter?.offset) || 0);
      return {
        records: selected.slice(offset, offset + limit), total: selected.length,
        summary: {
          total: records.length,
          pending: records.filter(record => record.status === "PENDING").length,
          uploading: records.filter(record => ["DOWNLOADING", "READY", "UPLOADING"].includes(record.status)).length,
          uploaded: records.filter(record => record.status === "UPLOADED").length,
          failed: records.filter(record => ["FAILED", "REJECTED", "CONFIRM_REQUIRED"].includes(record.status)).length,
        },
      };
    },
  );

  ipcMain.handle("pinduoduo-drama:upload-records:window:open", () => {
    openUploadRecordsWindow();
  });
  ipcMain.handle("pinduoduo-drama:upload-records:confirm-publication", async (_event, account: string, id: number, published: boolean) => {
    if (typeof account !== "string" || !account.trim() || !Number.isSafeInteger(id) || id <= 0 || typeof published !== "boolean") throw new Error("无效的发布确认参数");
    await getUploadRecordsRepository().confirmPublication(account, id, published);
  });

  ipcMain.handle("pinduoduo-drama:upload-records:retry-failed", async () => ({
    reset: await getUploadRecordsRepository().resetFailed(),
  }));

  ipcMain.handle(
    "pinduoduo-drama:upload-records:retry-one",
    async (_event, platformApplyId: number, accountName: string) => {
      if (!Number.isSafeInteger(platformApplyId) || platformApplyId <= 0) {
        throw new Error("无效的拼多多短剧记录 ID");
      }

      if (typeof accountName !== "string" || !accountName.trim()) throw new Error("请选择需要重试的账号任务");
      return { reset: await getUploadRecordsRepository().resetFailed(accountName, platformApplyId) };
    },
  );
}

export function stopPinduoduoDramaPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopPinduoduoDramaPlatformService() {
  return runtimeController.stop();
}
