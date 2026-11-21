import { createAccountControl } from "@/platforms/app-runtime/service";
export type WeiboDramaLoginState = "login-required" | "logged-in" | "unknown";

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

export type WeiboDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  assetDownloadDir: string;
  logDir: string;
  logFilePath: string;
};

export type WeiboDramaStoragePathKey =
  | keyof WeiboDramaStoragePaths
  | "configFilePath"
  | "latestLog";

export type WeiboDramaConfigResult = {
  config: WeiboDramaConfig;
  path: string;
  storagePaths: WeiboDramaStoragePaths;
  restartRequired: boolean;
};

export type WeiboDramaServiceStatus = {
  platform: "weibo-drama";
  running: boolean;
  addUrl: string;
  loginUrl: string;
  accounts: Array<{
    accountId: string;
    accountName: string;
    loginAccount?: string | null;
    launched: boolean;
    loginState: WeiboDramaLoginState;
    activeUrl?: string;
    userDataDir: string;
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
  }>;
  pid: number | null;
};

async function invokeWeiboDrama<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("微博 短剧服务控制仅在 Electron 应用内可用");
  }

  try {
    const result = await window.ipcRenderer.invoke(channel, ...args);
    return result as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const readableError = new Error(readableWeiboDramaError(message)) as Error & {
      cause?: unknown;
    };
    readableError.cause = error;
    throw readableError;
  }
}

function readableWeiboDramaError(message: string) {
  if (message.includes("WEIBO_DRAMA_ENABLED_ACCOUNT_NOT_FOUND")) {
    return "没有获取到已启用的 微博 账号，请先在后台开启账号";
  }
  if (message.includes("WEIBO_DRAMA_API_BASE_URL_REQUIRED")) {
    return "请先配置 微博 后台接口地址";
  }
  if (message.includes("WEIBO_DRAMA_ACCOUNT_CONFIG_RESPONSE_DATA_REQUIRED")) {
    return "微博 账号列表响应缺少 data，请检查登录状态和接口地址";
  }
  const requestFailed = message.match(/WEIBO_DRAMA_ACCOUNT_CONFIG_REQUEST_FAILED: (.*)/);
  if (requestFailed) {
    return `微博 账号列表获取失败：${requestFailed[1]}`;
  }
  return message;
}

export const weiboDramaService = {
  accountControl: createAccountControl("weibo-drama"),
  listAccounts: () =>
    invokeWeiboDrama<Array<{ accountId: string; accountName: string }>>(
      "weibo-drama:accounts:list",
    ),
  getConfig() {
    return invokeWeiboDrama<WeiboDramaConfigResult>("weibo-drama:config:get");
  },
  saveConfig(config: WeiboDramaConfig) {
    return invokeWeiboDrama<WeiboDramaConfigResult>("weibo-drama:config:save", config);
  },
  selectRunDataDir(currentPath?: string) {
    return invokeWeiboDrama<string | null>("weibo-drama:config:select-run-data-dir", currentPath);
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokeWeiboDrama<string | null>(
      "weibo-drama:config:select-local-episode-video-root",
      currentPath,
    );
  },
  openStoragePath(key: WeiboDramaStoragePathKey) {
    return invokeWeiboDrama<string>("weibo-drama:config:open-storage-path", key);
  },
  status() {
    return invokeWeiboDrama<WeiboDramaServiceStatus>("weibo-drama:service:status");
  },
  start(ids: string[]) {
    return invokeWeiboDrama<WeiboDramaServiceStatus>("weibo-drama:service:start", ids);
  },
  stop() {
    return invokeWeiboDrama<WeiboDramaServiceStatus>("weibo-drama:service:stop");
  },
};
