import { createAccountRuntimeGroup } from "../shared/account-runtime-group";
import { registerAccountControl } from "../shared/account-control";
import { seedUnconfirmedClaims, staleTaskMonitor } from "../shared/stale-task-monitor";
import { randomUUID } from "node:crypto";
import type {
  KuaishouDramaRuntimeOptions,
  KuaishouExecutionAttention,
} from "@dramabridge/kuaishou-drama-automation";
import { openAutomationDatabase } from "../../storage/database";
import { KuaishouExecutionRepository } from "../../storage/kuaishou-drama/execution-repository";
import { getKuaishouWorkerId } from "./worker-identity";
import { selectKuaishouAccounts } from "./account-selection";
import { app } from "electron";
import { registerKuaishouRecreationHandlers, stopKuaishouRecreation } from "./recreation";
import { registerKuaishouAccountSyncHandlers, stopKuaishouAccountSync } from "./account-sync";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import { registerTaskAnalyticsHandler } from "../shared/task-analytics";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
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
  workerId?: string;
  claimPausedReason?: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle?: string;
    status: "failed" | "running" | "succeeded" | "report-pending" | "review-required";
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
  recreationSheetName: string;
  recreationPollSeconds: string;
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
  executions: KuaishouExecutionAttention[];
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
  installationId: string;
  selectedAccountIds: string[];
  config: Partial<KuaishouDramaConfig> & Record<string, string | undefined>;
  dailyUploadLimitResumeAtByAccount?: Record<string, number>;
};

const defaultKuaishouDramaConfig: KuaishouDramaConfig = {
  recreationSheetName: "快手二创",
  recreationPollSeconds: "30",
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
        installationId: "",
        selectedAccountIds: [],
      },
    });
  }

  return store;
}

function normalizeConfig(
  config: Partial<KuaishouDramaConfig> & Record<string, string | undefined>,
): KuaishouDramaConfig {
  return {
    recreationSheetName: config.recreationSheetName?.trim() || defaultKuaishouDramaConfig.recreationSheetName,
    recreationPollSeconds: Number.isInteger(Number(config.recreationPollSeconds)) && Number(config.recreationPollSeconds) >= 10 && Number(config.recreationPollSeconds) <= 3600 ? String(Number(config.recreationPollSeconds)) : "30",
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
  return path.join(kuaishouDramaLogDir(config), `app-${formatDateKey()}.json`);
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
  return import("@dramabridge/kuaishou-drama-automation");
}
let executionRepository: KuaishouExecutionRepository | undefined;
function taskMonitor() {
  const monitor = staleTaskMonitor("kuaishou-drama", {
    apiBaseUrl: () => readConfig().apiBaseUrl,
    beforeSweep: async () => {
      const current = taskMonitor();
      await seedUnconfirmedClaims("kuaishou-drama", executions().list(readConfig().apiBaseUrl), current, record => executions().save(record));
    },
    onResolved: identity => {
      for (const record of executions().list(identity.apiBaseUrl, identity.accountId)) {
        if (record.taskId !== identity.taskId || record.workerId !== identity.workerId || record.attemptCount !== identity.attemptCount) continue;
        executions().save({ ...record, phase: "released", updatedAt: new Date().toISOString(), errorMessage: "定时巡检确认后台任务已结束或领取归属已变更，解除旧领取记录" });
      }
    },
    onReported: (identity, success) => {
      for (const record of executions().list(identity.apiBaseUrl, identity.accountId)) {
        if (record.taskId !== identity.taskId || record.workerId !== identity.workerId || record.attemptCount !== identity.attemptCount) continue;
        executions().save({ ...record, phase: "reported", updatedAt: new Date().toISOString(),
          report: { taskId: identity.taskId, workerId: identity.workerId, attemptCount: identity.attemptCount, success,
            ...(!success && { failStage: "OTHER" as const, errorMessage: "任务领取后连续4小时无进展，定时巡检已清理并上报失败" }) },
        });
      }
    },
  });
  for (const record of executions().list(readConfig().apiBaseUrl)) {
    if (!record.attemptCount || ["reported", "released", "claim-rejected"].includes(record.phase)) continue;
    if (record.ownerProcessId && record.ownerProcessId !== process.pid) {
      try { process.kill(record.ownerProcessId, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    monitor.seed({ taskId: record.taskId, accountId: record.accountId, workerId: record.workerId,
      attemptCount: record.attemptCount, apiBaseUrl: record.apiBaseUrl }, record.updatedAt, record.report?.success === true);
  }
  return monitor;
}

function executions() {
  if (!executionRepository) {
    executionRepository = new KuaishouExecutionRepository(openAutomationDatabase().database);
    executionRepository.recoverInterrupted();
  }
  return executionRepository;
}
function executionAttention(): KuaishouExecutionAttention[] {
  return executions()
    .list(readConfig().apiBaseUrl)
    .filter((record) =>
      ["review-required", "report-pending", "report-blocked"].includes(record.phase),
    )
    .map(
      ({
        id,
        accountId,
        taskId,
        workerId,
        attemptCount,
        originalTitle,
        phase,
        errorMessage,
        updatedAt,
      }) => ({
        id,
        accountId,
        taskId,
        workerId,
        attemptCount,
        originalTitle,
        phase,
        errorMessage,
        updatedAt,
      }),
    );
}

function findLatestLogPath(paths = storagePaths()) {
  return findLatestFile(paths.logDir, (fileName) =>
    /^app(?:-.+)?-\d{4}-\d{2}-\d{2}\.(?:log|jsonl)$/i.test(fileName),
  );
}

async function defaultStoppedStatus(): Promise<KuaishouDramaServiceStatus> {
  return {
    platform: "kuaishou-drama",
    running: false,
    accounts: [],
    pid: null,
    executions: executionAttention(),
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
    executions: executionAttention(),
  };
}

async function startRuntime(selectedAccountIds: unknown) {
  const runtime = await createAccountRuntimeGroup(selectedAccountIds, (id, canClaimTask) => startAccountRuntime([id], canClaimTask));
  getStore().set("selectedAccountIds", runtime.getStatus().accounts.filter(account => account.launched).map(account => account.accountId));
  return runtime;
}

async function startAccountRuntime(selectedAccountIds: unknown, canClaimTask: () => boolean) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();

  const config = readConfig();
  const workerId = await getKuaishouWorkerId(() => {
    const saved = getStore().get("installationId");
    if (saved) return saved;
    const generated = randomUUID();
    getStore().set("installationId", generated);
    return generated;
  });
  const { flushPendingKuaishouReports } = await importKuaishouDramaRuntimePackage();
  const pendingAccounts = new Set(
    executions()
      .list(config.apiBaseUrl)
      .filter((record) => record.phase === "report-pending")
      .map((record) => record.accountId),
  );
  for (const accountId of pendingAccounts)
    await flushPendingKuaishouReports({
      store: executions(),
      apiBaseUrl: config.apiBaseUrl,
      accountId,
    });
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
    throw new Error("请先在快手短剧配置中选择本地剧集视频目录，再启动服务");
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
  const { fetchKuaishouDramaAccounts, claimNextKuaishouDramaTaskApi, startKuaishouDramaRuntime } =
    await importKuaishouDramaRuntimePackage();
  const enabledAccounts = await fetchKuaishouDramaAccounts(config.apiBaseUrl);
  if (!enabledAccounts.length) throw new Error("KUAISHOU_DRAMA_ENABLED_ACCOUNT_NOT_FOUND");

  const accounts = selectKuaishouAccounts(enabledAccounts, selectedAccountIds);
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
      const runtimeOptions: KuaishouDramaRuntimeOptions = {
        canClaimTask,
        workerId,
        executionStore: executions(),
        taskWatchdog: taskMonitor(),
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
        ensureBaiduNetdiskResource: (
          request: Parameters<typeof ensureBaiduNetdiskShareDownloaded>[0],
        ) =>
          ensureBaiduNetdiskShareDownloaded({
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
  registerAccountControl({ platform: "kuaishou-drama", controller: runtimeController, start: startRuntime, status, onStarted: () => getStore().set("selectedAccountIds", runtimeController.current?.getStatus().accounts.filter(account => account.launched).map(account => account.accountId) ?? []) });
  taskMonitor();
  ipcMain.handle("kuaishou-drama:tasks:cleanup", () => taskMonitor().sweep());
  registerKuaishouRecreationHandlers(readConfig);
  registerKuaishouAccountSyncHandlers({
    prepare: async (id) => {
      process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
      const accounts = await (await importKuaishouDramaRuntimePackage()).fetchKuaishouDramaAccounts(readConfig().apiBaseUrl);
      const account = accounts.find(account => account.accountId === id);
      if (!account) throw new Error("请选择有效的快手来源账号");
      const paths = storagePaths(readConfig(), id);
      if (!existsSync(paths.credentialStatePath)) throw new Error(`“${account.accountName}”暂无登录凭证，请先在实例页面登录快手`);
      return { ...paths, accountId: account.accountId, accountName: account.accountName };
    },
  });
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

  ipcMain.handle("kuaishou-drama:execution:recheck", async (_event, id: string) => {
    if (runtimeController.running || runtimeController.startingPromise)
      throw new Error("请先停止快手服务，并在快手和后台核实、处理该任务，再重新检查");
    const record = executions().get(id);
    if (!record || record.apiBaseUrl !== readConfig().apiBaseUrl.trim().replace(/\/+$/, ""))
      throw new Error("未找到当前后台的本地任务记录");
    if (!["review-required", "report-blocked"].includes(record.phase))
      throw new Error("该记录无需人工解除；待补报记录会在服务启动后自动重试");
    const task = await (
      await importKuaishouDramaRuntimePackage()
    ).fetchKuaishouAccountTaskApi({
      apiBaseUrl: record.apiBaseUrl,
      accountId: record.accountId,
      taskId: record.taskId,
    });
    if (runtimeController.running || runtimeController.startingPromise)
      throw new Error("检查期间服务已启动，请先停止服务再检查");
    if (executions().get(id)?.updatedAt !== record.updatedAt)
      throw new Error("任务记录已更新，请刷新后重新检查");
    if (
      !task ||
      !["READY", "FAILED", "COMPLETED", "CANCELED", "DRAFT", "CONTRACT_FILLING"].includes(
        task.status || "",
      )
    ) {
      throw new Error(
        "后台任务仍在上传中或状态无法确认。请先在快手确认是否已提交，并在后台处理占用，再重新检查",
      );
    }
    executions().save({
      ...record,
      phase: "released",
      updatedAt: new Date().toISOString(),
      errorMessage: `用户已在后台核实处理，重新检查状态为 ${task.status}，保留原领取和结果记录`,
    });
    return status();
  });
  ipcMain.handle("kuaishou-drama:accounts:list", async () => {
    const accounts = await (
      await importKuaishouDramaRuntimePackage()
    ).fetchKuaishouDramaAccounts(readConfig().apiBaseUrl);
    const selectedIds = new Set(
      runtimeController.current?.getStatus().accounts.map((account) => account.accountId) ??
        getStore().get("selectedAccountIds"),
    );
    return {
      accounts: accounts.map((account) => ({ ...account, status: "ON" })),
      selectedAccountIds: accounts
        .filter((account) => selectedIds.has(account.accountId))
        .map((account) => account.accountId),
    };
  });
  ipcMain.handle("kuaishou-drama:service:start", async (_event, selectedAccountIds: unknown) => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) {
      await runtimeController.stop();
    }

    await runtimeController.start(() => startRuntime(selectedAccountIds));
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

export async function stopKuaishouDramaPlatformService() {
  await stopKuaishouAccountSync();
  await stopKuaishouRecreation();
  await runtimeController.stop();
}
