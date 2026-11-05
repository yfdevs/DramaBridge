import type { TaskSweepResult } from "@dramabridge/automation-logging"
export type KuaishouDramaAccount = {
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  status: string;
};
export type KuaishouExecutionAttention = {
  id: string;
  accountId: string;
  taskId: number;
  workerId: string;
  attemptCount?: number;
  originalTitle?: string;
  phase: string;
  errorMessage?: string;
  updatedAt: string;
};
export type KuaishouDramaLoginState = "login-required" | "logged-in" | "unknown";

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

export type KuaishouDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type KuaishouDramaStoragePathKey =
  | keyof KuaishouDramaStoragePaths
  | "configFilePath"
  | "latestLog";

export type KuaishouDramaConfigResult = {
  config: KuaishouDramaConfig;
  path: string;
  storagePaths: KuaishouDramaStoragePaths;
  restartRequired: boolean;
};

export type KuaishouDramaServiceStatus = {
  platform: "kuaishou-drama";
  running: boolean;
  accounts: Array<{
    accountId: string;
    accountName: string;
    loginAccount?: string | null;
    launched: boolean;
    loginState: KuaishouDramaLoginState;
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
  }>;
  executions: KuaishouExecutionAttention[];
  pid: number | null;
};

async function invokeKuaishouDrama<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("快手短剧服务控制仅在 Electron 应用内可用。");
  }

  try {
    const result = await window.ipcRenderer.invoke(channel, ...args);
    return result as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("KUAISHOU_DRAMA_ENABLED_ACCOUNT_NOT_FOUND")) {
      throw Object.assign(new Error("没有获取到已启用的快手账号，请先在后台创建并开启账号配置。"), { cause: error });
    }
    if (message.includes("KUAISHOU_DRAMA_API_BASE_URL_REQUIRED")) {
      throw Object.assign(new Error("请先配置快手后台接口地址。"), { cause: error });
    }
    throw error;
  }
}

export const kuaishouDramaService = {
  cleanupTasks: () => invokeKuaishouDrama<TaskSweepResult>("kuaishou-drama:tasks:cleanup"),
  getConfig() {
    return invokeKuaishouDrama<KuaishouDramaConfigResult>("kuaishou-drama:config:get");
  },
  saveConfig(config: KuaishouDramaConfig) {
    return invokeKuaishouDrama<KuaishouDramaConfigResult>("kuaishou-drama:config:save", config);
  },
  selectRunDataDir(currentPath?: string) {
    return invokeKuaishouDrama<string | null>(
      "kuaishou-drama:config:select-run-data-dir",
      currentPath,
    );
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokeKuaishouDrama<string | null>(
      "kuaishou-drama:config:select-local-episode-video-root",
      currentPath,
    );
  },
  openStoragePath(key: KuaishouDramaStoragePathKey) {
    return invokeKuaishouDrama<string>("kuaishou-drama:config:open-storage-path", key);
  },
  status() {
    return invokeKuaishouDrama<KuaishouDramaServiceStatus>("kuaishou-drama:service:status");
  },
  listAccounts() {
    return invokeKuaishouDrama<{ accounts: KuaishouDramaAccount[]; selectedAccountIds: string[] }>(
      "kuaishou-drama:accounts:list",
    );
  },
  recheckExecution(id: string) {
    return invokeKuaishouDrama<KuaishouDramaServiceStatus>("kuaishou-drama:execution:recheck", id);
  },
  start(selectedAccountIds: string[]) {
    return invokeKuaishouDrama<KuaishouDramaServiceStatus>(
      "kuaishou-drama:service:start",
      selectedAccountIds,
    );
  },
  stop() {
    return invokeKuaishouDrama<KuaishouDramaServiceStatus>("kuaishou-drama:service:stop");
  },
};
