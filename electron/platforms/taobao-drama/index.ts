import { app, Notification } from "electron";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaobaoExecutionAttention } from "@dramabridge/taobao-drama-automation";
import { openAutomationDatabase } from "../../storage/database";
import { TaobaoExecutionRepository } from "../../storage/taobao-drama/execution-repository";
import { getTaobaoWorkerId } from "./worker-identity";
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";
import { registerRuntimeAssetCleanupRoot } from "../../runtime-asset-cleanup";
import { registerTaskAnalyticsHandler } from "../shared/task-analytics";
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
  rpaProfileKey?: string | null;
};
type AccountStatus = {
  platform: "taobao-drama"; running: boolean; loginState: "login-required" | "verification-required" | "logged-in" | "unknown";
  activeUrl?: string; collectionCreateUrl: string; batchPublishUrl: string; loginUrl: string; userDataDir: string;
  workerId?: string; claimPausedReason?: string;
  accountProfileName?: string; lastTask?: { accountTaskId: number; originalTitle?: string; status: "running" | "succeeded" | "failed" | "report-pending" | "review-required"; errorMessage?: string; updatedAt: string };
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
export type TaobaoDramaServiceStatus = RuntimeStatus & { pid: number | null; executions: TaobaoExecutionAttention[] };

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
type StoredConfig = { config: TaobaoDramaConfig; installationId: string };
let store: Store<StoredConfig> | null = null;
let executionRepository: TaobaoExecutionRepository | undefined;
function executions() {
  if (!executionRepository) {
    const repository = new TaobaoExecutionRepository(openAutomationDatabase().database);
    // Recover all backend/account scopes even if an old account is now disabled.
    repository.recoverInterrupted();
    executionRepository = repository;
  }
  return executionRepository;
}
function executionAttention(): TaobaoExecutionAttention[] {
  return executions().list(readConfig().apiBaseUrl)
    .filter((record) => ["review-required", "report-pending", "report-blocked"].includes(record.phase))
    .map(({ id, accountId, taskId, workerId, attemptCount, originalTitle, phase, errorMessage, updatedAt }) =>
      ({ id, accountId, taskId, workerId, attemptCount, originalTitle, phase, errorMessage, updatedAt }));
}

function notifyTaobaoHumanVerification(account: Account) {
  const accountLabel = account.accountName?.trim() || account.accountId;
  if (Notification.isSupported()) {
    new Notification({
      title: "淘宝需要手动验证",
      body: `${accountLabel} 的发布任务已暂停，请打开淘宝浏览器完成验证码，验证通过后任务会自动继续。`,
    }).show();
  }
}

function configStore(): Store<StoredConfig> {
  if (!store) store = createValidatedStore<StoredConfig>({ name: "taobao-drama-config", defaults: { config: defaults, installationId: "" } });
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
    logDir, logFilePath: path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.json`),
  };
}
function ensureDirectories(paths: StoragePaths) {
  ensureDirectoryPaths([paths.runDataDir, paths.accountDir, paths.userDataDir, paths.assetDownloadDir, paths.logDir]);
}
function latestLog(paths = storagePaths()) {
  return findLatestFile(paths.logDir, (fileName) => /\.(?:json|jsonl|log)$/i.test(fileName));
}
async function runtimePackage() {
  return import("@dramabridge/taobao-drama-automation") as unknown as Promise<{
    fetchTaobaoDramaAccounts: (baseUrl: string) => Promise<Account[]>;
    flushPendingTaobaoReports: (options: { store: TaobaoExecutionRepository; apiBaseUrl: string; accountId: string }) => Promise<void>;
    fetchTaobaoAccountTaskApi: (options: { apiBaseUrl: string; accountId: string; taskId: number }) => Promise<{ status?: string | null } | undefined>;
    startTaobaoDramaRuntime: (options: Record<string, unknown>) => Promise<AccountRuntime>;
    testTaobaoBrowserExecutable: (path: string) => Promise<{ ok: boolean; message: string }>;
  }>;
}
function stoppedStatus(): TaobaoDramaServiceStatus {
  return { platform: "taobao-drama", running: false, collectionCreateUrl, batchPublishUrl, loginUrl, accounts: [], pid: null, executions: executionAttention() };
}
async function status(): Promise<TaobaoDramaServiceStatus> {
  const runtime = controller.current;
  if (!runtime) return stoppedStatus();
  const current = runtime.getStatus();
  if (!current.running) { await controller.stop(); return stoppedStatus(); }
  return { ...current, pid: process.pid, executions: executionAttention() };
}

async function startRuntime(): Promise<Runtime> {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  const config = readConfig();
  const workerId = await getTaobaoWorkerId(() => {
    const saved = configStore().get("installationId");
    if (saved) return saved;
    const generated = randomUUID(); configStore().set("installationId", generated); return generated;
  });
  const { fetchTaobaoDramaAccounts, startTaobaoDramaRuntime, flushPendingTaobaoReports } = await runtimePackage();
  // Report recovery must not depend on an enabled account or a valid browser login.
  const pendingAccounts = new Set(executions().list(config.apiBaseUrl).filter((record) => record.phase === "report-pending").map((record) => record.accountId));
  for (const accountId of pendingAccounts) {
    await flushPendingTaobaoReports({ store: executions(), apiBaseUrl: config.apiBaseUrl, accountId });
  }
  const accounts = await fetchTaobaoDramaAccounts(config.apiBaseUrl);
  if (!accounts.length) throw new Error("TAOBAO_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");
  const accountRuntimes: Array<{ account: Account; runtime: AccountRuntime }> = [];
  try {
    for (const account of accounts) {
      const accountProfileName = account.rpaProfileKey?.trim() || account.accountId;
      const paths = storagePaths(config, accountProfileName); ensureDirectories(paths);
      const runtime = await startTaobaoDramaRuntime({
        workerId, executionStore: executions(),
        accountProfileName, accountId: account.accountId, accountName: account.accountName,
        accountDir: paths.accountDir, userDataDir: paths.userDataDir, credentialStatePath: paths.credentialStatePath,
        assetDownloadDir: paths.assetDownloadDir, logFilePath: paths.logFilePath, logRetentionDays: Number(config.logRetentionDays) || 3,
        localMaterialRoot: config.localMaterialRoot, apiConfig: { baseUrl: config.apiBaseUrl },
        baiduNetdiskDownloadRetryAttempts: Number(config.baiduNetdiskDownloadRetryAttempts) || 0,
        episodeUploadWaitTimeoutMinutes: Number(config.episodeUploadWaitTimeoutMinutes) || 120,
        taskPollIntervalMs: Math.max(1, Number(config.taskPollIntervalSeconds) || 10) * 1_000,
        closeFailedTaskPages: config.closeFailedTaskPages === "true", aiClientFactory: createConfiguredAiClient,
        aiImageModel: getConfiguredAiImageModel(), aiCoverGenerationRetryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        onHumanVerificationRequired: () => notifyTaobaoHumanVerification(account),
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
  ipcMain.handle("taobao-drama:execution:recheck", async (_event, id: string) => {
    if (controller.running || controller.startingPromise) throw new Error("请先停止淘宝服务，并在淘宝和后台核实、处理该任务，再重新检查。");
    const record = executions().get(id);
    if (!record || record.apiBaseUrl !== readConfig().apiBaseUrl.trim().replace(/\/+$/, "")) throw new Error("未找到当前后台的本地任务记录。");
    if (!["review-required", "report-blocked"].includes(record.phase)) throw new Error("该记录无需人工解除；待补报记录会在服务启动后自动重试。");
    const task = await (await runtimePackage()).fetchTaobaoAccountTaskApi({ apiBaseUrl: record.apiBaseUrl, accountId: record.accountId, taskId: record.taskId });
    if (controller.running || controller.startingPromise) throw new Error("检查期间服务已启动，请先停止服务再检查。");
    if (executions().get(id)?.updatedAt !== record.updatedAt) throw new Error("任务记录已更新，请刷新后重新检查。");
    if (!task || !["READY", "FAILED", "COMPLETED", "CANCELED", "DRAFT", "CONTRACT_FILLING"].includes(task.status || "")) {
      throw new Error("后台任务仍在上传中或状态无法确认。请先在淘宝确认是否已提交，并在后台处理占用，再重新检查。");
    }
    executions().save({ ...record, phase: "released", updatedAt: new Date().toISOString(),
      errorMessage: `用户已在后台核实处理，重新检查状态为 ${task.status}，保留原领取和结果记录。` });
    return status();
  });
  ipcMain.handle("taobao-drama:service:start", async () => { assertGlobalDirectoriesConfigured(); await controller.start(startRuntime); return status(); });
  ipcMain.handle("taobao-drama:service:stop", async () => { await controller.stop(); return status(); });
}
export function stopTaobaoDramaPlatformRuntime() { controller.stopInBackground(); }
export function stopTaobaoDramaPlatformService() { return controller.stop(); }
