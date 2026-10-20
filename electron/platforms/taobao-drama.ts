import { app, ipcMain, Notification } from "electron";
import Store from "electron-store";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../global-app-config";
import { registerRuntimeAssetCleanupRoot } from "../runtime-asset-cleanup";
import { registerTaskAnalyticsHandler } from "./task-analytics";
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from "./baidu-netdisk";
import {
  directoryDefaultPath,
  normalizePlatformRunDataDir,
  openExistingPath,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "./shared";

type Account = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};
type AccountStatus = {
  platform: "taobao-drama"; running: boolean; loginState: "login-required" | "verification-required" | "logged-in" | "unknown";
  activeUrl?: string; collectionCreateUrl: string; batchPublishUrl: string; loginUrl: string; userDataDir: string;
  accountProfileName?: string; lastTask?: { accountTaskId: number; originalTitle?: string; status: "running" | "succeeded" | "failed"; errorMessage?: string; updatedAt: string };
};
type AccountRuntime = { getStatus: () => AccountStatus; stop: () => Promise<void> };
type RuntimeStatus = {
  platform: "taobao-drama"; running: boolean; collectionCreateUrl: string; batchPublishUrl: string; loginUrl: string;
  accounts: Array<AccountStatus & { accountId: string; accountName: string; loginAccount?: string | null; launched: boolean }>;
};
type Runtime = { getStatus: () => RuntimeStatus; stop: () => Promise<void> };

export type TaobaoDramaConfig = {
  accountProfileName: string; apiBaseUrl: string; browserExecutablePath: string; headless: string;
  operationDelaySeconds: string; taskPollIntervalSeconds: string; baiduNetdiskDownloadRetryAttempts: string;
  episodeUploadWaitTimeoutMinutes: string; closeFailedTaskPages: string; runDataDir: string; logRetentionDays: string;
};
type StoragePaths = { runDataDir: string; accountDir: string; userDataDir: string; credentialStatePath: string; assetDownloadDir: string; logDir: string; logFilePath: string };
export type TaobaoDramaServiceStatus = RuntimeStatus & { pid: number | null };

const collectionCreateUrl = "https://creator.guanghe.taobao.com/page/unify/collect-create?type=1&collectConfig=%5B1%2C3%5D&mode=0&source=guanghe&from=%2Fpage%2Funify%2Fcollection";
const batchPublishUrl = "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish";
const loginUrl = `https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&sub=true&redirectURL=${encodeURIComponent(collectionCreateUrl)}`;

function defaultBrowserPath() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "";
}

const defaults: TaobaoDramaConfig = {
  accountProfileName: "default", apiBaseUrl: "http://180.184.76.232:19090", browserExecutablePath: defaultBrowserPath(),
  headless: "false", operationDelaySeconds: "0", taskPollIntervalSeconds: "10", baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120", closeFailedTaskPages: "false", runDataDir: "D:\\.drama-runs\\taobao-drama", logRetentionDays: "3",
};
const controller = new RuntimeController<Runtime>();
let store: Store<{ config: TaobaoDramaConfig }> | null = null;

function configStore(): Store<{ config: TaobaoDramaConfig }> {
  if (!store) store = new Store({ name: "taobao-drama-config", defaults: { config: defaults } });
  return store;
}
function numberText(value: string | undefined, fallback: string, minimum = 0) {
  const parsed = Number(value); return value?.trim() && Number.isFinite(parsed) && parsed >= minimum ? value.trim() : fallback;
}
function normalizeConfig(config: Partial<TaobaoDramaConfig>): TaobaoDramaConfig {
  return {
    accountProfileName: config.accountProfileName?.trim() || defaults.accountProfileName,
    apiBaseUrl: config.apiBaseUrl?.trim() || defaults.apiBaseUrl,
    browserExecutablePath: config.browserExecutablePath?.trim() ?? defaults.browserExecutablePath,
    headless: config.headless ?? defaults.headless,
    operationDelaySeconds: numberText(config.operationDelaySeconds, defaults.operationDelaySeconds),
    taskPollIntervalSeconds: numberText(config.taskPollIntervalSeconds, defaults.taskPollIntervalSeconds, 1),
    baiduNetdiskDownloadRetryAttempts: numberText(config.baiduNetdiskDownloadRetryAttempts, defaults.baiduNetdiskDownloadRetryAttempts),
    episodeUploadWaitTimeoutMinutes: numberText(config.episodeUploadWaitTimeoutMinutes, defaults.episodeUploadWaitTimeoutMinutes, 1),
    closeFailedTaskPages: config.closeFailedTaskPages ?? defaults.closeFailedTaskPages,
    runDataDir: config.runDataDir?.trim() || defaults.runDataDir,
    logRetentionDays: numberText(config.logRetentionDays, defaults.logRetentionDays, 1),
  };
}
function readConfig() {
  const config = normalizeConfig(configStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("taobao-drama", { runDataDir: config.runDataDir, localMaterialRoot: "" });
  return { ...config, ...directories };
}
function runDataDir(config: Pick<TaobaoDramaConfig, "runDataDir"> = readConfig()) { return resolveFromAppRoot(config.runDataDir); }
function storagePaths(
  config: TaobaoDramaConfig & { localMaterialRoot?: string } = readConfig(),
  accountProfileName = config.accountProfileName,
): StoragePaths {
  const encoded = encodeURIComponent(accountProfileName.trim() || "default");
  const accountDir = path.join(runDataDir(config), "auth", "accounts", encoded);
  const logDir = path.join(runDataDir(config), "logs");
  return {
    runDataDir: runDataDir(config), accountDir, userDataDir: path.join(accountDir, "chromium-profile"),
    credentialStatePath: path.join(accountDir, "storage-state.json"), assetDownloadDir: path.join(runDataDir(config), "assets", encoded),
    logDir, logFilePath: path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`),
  };
}
function ensureDirectories(paths: StoragePaths) { Object.values(paths).filter((value) => !path.extname(value)).forEach((directory) => mkdirSync(directory, { recursive: true })); mkdirSync(paths.logDir, { recursive: true }); }
function latestLog(paths = storagePaths()) {
  mkdirSync(paths.logDir, { recursive: true });
  return readdirSync(paths.logDir, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(?:log|jsonl)$/i.test(entry.name))
    .map((entry) => path.join(paths.logDir, entry.name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? paths.logDir;
}
function openPathOrParent(value: string) { return openExistingPath(existsSync(value) ? value : path.dirname(value)); }
async function runtimePackage() {
  return import("@dramabridge/taobao-drama-automation") as unknown as Promise<{
    fetchTaobaoDramaAccounts: (baseUrl: string) => Promise<Account[]>;
    startTaobaoDramaRuntime: (options: Record<string, unknown>) => Promise<AccountRuntime>;
    testTaobaoBrowserExecutable: (path: string) => Promise<{ ok: boolean; message: string }>;
  }>;
}
function stoppedStatus(): TaobaoDramaServiceStatus {
  return { platform: "taobao-drama", running: false, collectionCreateUrl, batchPublishUrl, loginUrl, accounts: [], pid: null };
}
async function status(): Promise<TaobaoDramaServiceStatus> {
  const runtime = controller.current;
  if (!runtime) return stoppedStatus();
  const current = runtime.getStatus();
  if (!current.running) { await controller.stop(); return stoppedStatus(); }
  return { ...current, pid: process.pid };
}

async function startRuntime(): Promise<Runtime> {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const { fetchTaobaoDramaAccounts, startTaobaoDramaRuntime } = await runtimePackage();
  const accounts = await fetchTaobaoDramaAccounts(config.apiBaseUrl);
  if (!accounts.length) throw new Error("TAOBAO_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");
  const accountRuntimes: Array<{ account: Account; runtime: AccountRuntime }> = [];
  try {
    for (const account of accounts) {
      const accountProfileName = account.rpaProfileKey?.trim() || account.accountId;
      const paths = storagePaths(config, accountProfileName); ensureDirectories(paths);
      const runtime = await startTaobaoDramaRuntime({
        accountProfileName, accountId: account.accountId, accountName: account.accountName,
        accountDir: paths.accountDir, userDataDir: paths.userDataDir, credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir, logFilePath: paths.logFilePath, logRetentionDays: Number(config.logRetentionDays) || 3,
        localMaterialRoot: config.localMaterialRoot, apiConfig: { baseUrl: config.apiBaseUrl },
        baiduNetdiskDownloadRetryAttempts: Number(config.baiduNetdiskDownloadRetryAttempts) || 0,
        episodeUploadWaitTimeoutMinutes: Number(config.episodeUploadWaitTimeoutMinutes) || 120,
        taskPollIntervalMs: Math.max(1, Number(config.taskPollIntervalSeconds) || 10) * 1_000,
        closeFailedTaskPages: config.closeFailedTaskPages === "true", aiClientFactory: createConfiguredAiClient,
        aiImageModel: getConfiguredAiImageModel(), aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        onHumanVerificationRequired: () => Notification.isSupported() && new Notification({ title: "淘宝需要人工验证", body: `${account.accountName} 需要完成淘宝安全校验。` }).show(),
        ensureBaiduNetdiskResource: (request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0]) => ensureBaiduNetdiskShareDownloaded({ ...request, requesterPlatform: "taobao-drama" }),
        cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
        config: { browser: { executablePath: config.browserExecutablePath || undefined, headless: config.headless === "true", slowMo: (Number(config.operationDelaySeconds) || 0) * 1_000 } },
      });
      accountRuntimes.push({ account, runtime });
    }
  } catch (error) {
    await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop())); throw error;
  }
  let running = true;
  return {
    getStatus() {
      const runtimeAccounts = accountRuntimes.map(({ account, runtime }) => ({ ...runtime.getStatus(), accountId: account.accountId, accountName: account.accountName, loginAccount: account.loginAccount, launched: runtime.getStatus().running }));
      if (runtimeAccounts.every((account) => !account.launched)) running = false;
      return { platform: "taobao-drama", running, collectionCreateUrl, batchPublishUrl, loginUrl, accounts: runtimeAccounts };
    },
    async stop() { running = false; await Promise.allSettled(accountRuntimes.map(({ runtime }) => runtime.stop())); },
  };
}

export function getTaobaoDramaBrowserInstanceCount() { return controller.current?.getStatus().accounts.filter((account) => account.launched).length ?? 0; }
export function getTaobaoDramaRunningPlatformCount() { return controller.current?.getStatus().running ? 1 : 0; }
export function getTaobaoDramaPlatformRuntimeSummary() {
  const current = controller.current?.getStatus(); const paths = storagePaths();
  return { platform: "taobao-drama" as const, running: Boolean(current?.running),
    startedAt: controller.startedAt, browserInstanceCount: current?.accounts.filter((a) => a.launched).length ?? 0,
    browserInstances: current?.accounts.filter((a) => a.launched).map((a) => ({ id: a.accountId, label: a.accountName, loginState: a.loginState, activeUrl: a.activeUrl })) ?? [], logDir: paths.logDir };
}
export function openTaobaoDramaLogDir() { const paths = storagePaths(); ensureDirectories(paths); return openExistingPath(paths.logDir); }

export function registerTaobaoDramaPlatformHandlers() {
  registerTaskAnalyticsHandler({ platform: "taobao-drama", apiBaseUrl: () => readConfig().apiBaseUrl, apiPrefix: "/dramaAiRpa/taobao" });
  registerRuntimeAssetCleanupRoot({ platform: "taobao-drama", rootPath: path.join(storagePaths().runDataDir, "assets"), maxDepth: 2, retentionMs: 3 * 60 * 60 * 1_000 });
  ipcMain.handle("taobao-drama:config:get", () => ({ config: readConfig(), path: configStore().path, storagePaths: storagePaths(), restartRequired: false }));
  ipcMain.handle("taobao-drama:config:save", (_event, value: TaobaoDramaConfig) => {
    const config = normalizeConfig(value); configStore().set("config", config);
    return { config, path: configStore().path, storagePaths: storagePaths(config), restartRequired: controller.running || controller.startingPromise !== null };
  });
  ipcMain.handle("taobao-drama:config:test-browser-path", async (_event, executablePath: string) => (await runtimePackage()).testTaobaoBrowserExecutable(executablePath));
  ipcMain.handle("taobao-drama:config:select-run-data-dir", async (event, current?: string) => normalizePlatformRunDataDir(await selectDirectory(event, { title: "选择淘宝短剧运行数据目录", defaultPath: directoryDefaultPath(current, app.getPath("documents")), properties: ["openDirectory", "createDirectory"] }), "taobao-drama"));
  ipcMain.handle("taobao-drama:config:open-storage-path", (_event, key: keyof StoragePaths | "configFilePath" | "latestLog") => {
    const paths = storagePaths(); ensureDirectories(paths);
    if (key === "configFilePath") return openPathOrParent(configStore().path);
    if (key === "latestLog") return openExistingPath(latestLog(paths));
    if (key === "credentialStatePath" || key === "logFilePath") return openPathOrParent(paths[key]);
    return openExistingPath(paths[key]);
  });
  ipcMain.handle("taobao-drama:service:status", () => status());
  ipcMain.handle("taobao-drama:service:start", async () => { assertGlobalDirectoriesConfigured(); await controller.start(startRuntime); return status(); });
  ipcMain.handle("taobao-drama:service:stop", async () => { await controller.stop(); return status(); });
}
export function stopTaobaoDramaPlatformRuntime() { controller.stopInBackground(); }
export function stopTaobaoDramaPlatformService() { return controller.stop(); }
