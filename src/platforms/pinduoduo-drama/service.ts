export type PinduoduoDramaLoginState = "login-required" | "logged-in" | "unknown";

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

export type PinduoduoDramaStoragePaths = {
  runDataDir: string;
  accountDir: string;
  userDataDir: string;
  credentialStatePath: string;
  logDir: string;
  logFilePath: string;
};

export type PinduoduoDramaStoragePathKey =
  | keyof PinduoduoDramaStoragePaths
  | "configFilePath"
  | "latestLog";

export type PinduoduoDramaConfigResult = {
  config: PinduoduoDramaConfig;
  path: string;
  storagePaths: PinduoduoDramaStoragePaths;
  restartRequired: boolean;
};

export type PinduoduoDramaServiceStatus = {
  platform: "pinduoduo-drama";
  running: boolean;
  loginState: PinduoduoDramaLoginState;
  activeUrl?: string;
  manageUrl: string;
  loginExpiredUrl: string;
  userDataDir: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  logFilePath?: string;
  pid: number | null;
  instances?: Array<{ id: string; name: string; launched: boolean; loginState: string }>;
  accountErrors?: Record<string, string>;
};

export type PinduoduoUploadRecord = {
  platformApplyId: number;
  title: string;
  episodeCount?: number;
  demoUrl?: string;
  status?: string;
  stage?: string;
  errorMessage?: string;
  attempts?: number;
  rawJson?: string;
  resourceSource?: "FEISHU" | "LEGACY_XLSX_ORIGINAL" | "PINDUODUO_LIST";
  resourceSourceRows?: number[];
  accountProfileName?: string;
  uploadedAt?: string;
  lastAttemptAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type PinduoduoUploadRecordsSummary = {
  total: number;
  pending: number;
  uploading: number;
  uploaded: number;
  failed: number;
};

export type PinduoduoUploadRecordsFilter = {
  status?: string;
  limit?: number;
  offset?: number;
};

export type PinduoduoUploadRecordsResult = {
  records: PinduoduoUploadRecord[];
  total: number;
  summary: PinduoduoUploadRecordsSummary;
};

async function invokePinduoduoDrama<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("拼多多短剧服务控制仅在 Electron 应用内可用");
  }

  const result = await window.ipcRenderer.invoke(channel, ...args);
  return result as T;
}

export const pinduoduoDramaService = {
  testSourceTable(url: string) {
    return invokePinduoduoDrama<{ sheetName: string; titleCount: number }>("pinduoduo-drama:config:test-source-table", url);
  },
  getConfig() {
    return invokePinduoduoDrama<PinduoduoDramaConfigResult>("pinduoduo-drama:config:get");
  },
  saveConfig(config: PinduoduoDramaConfig) {
    return invokePinduoduoDrama<PinduoduoDramaConfigResult>("pinduoduo-drama:config:save", config);
  },
  testBrowserPath(executablePath: string) {
    return invokePinduoduoDrama<{ ok: boolean; message: string }>(
      "pinduoduo-drama:config:test-browser-path",
      executablePath,
    );
  },
  selectRunDataDir(currentPath?: string) {
    return invokePinduoduoDrama<string | null>(
      "pinduoduo-drama:config:select-run-data-dir",
      currentPath,
    );
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokePinduoduoDrama<string | null>(
      "pinduoduo-drama:config:select-local-episode-video-root",
      currentPath,
    );
  },
  openStoragePath(key: PinduoduoDramaStoragePathKey) {
    return invokePinduoduoDrama<string>("pinduoduo-drama:config:open-storage-path", key);
  },
  status() {
    return invokePinduoduoDrama<PinduoduoDramaServiceStatus>("pinduoduo-drama:service:status");
  },
  start() {
    return invokePinduoduoDrama<PinduoduoDramaServiceStatus>("pinduoduo-drama:service:start");
  },
  stop() {
    return invokePinduoduoDrama<PinduoduoDramaServiceStatus>("pinduoduo-drama:service:stop");
  },
  listUploadRecords(filter?: PinduoduoUploadRecordsFilter) {
    return invokePinduoduoDrama<PinduoduoUploadRecordsResult>(
      "pinduoduo-drama:upload-records:list",
      filter,
    );
  },
  openUploadRecordsWindow() {
    return invokePinduoduoDrama<void>("pinduoduo-drama:upload-records:window:open");
  },
  retryFailedUploadRecords() {
    return invokePinduoduoDrama<{ reset: number }>(
      "pinduoduo-drama:upload-records:retry-failed",
    );
  },
  retryUploadRecord(platformApplyId: number, accountName: string) {
    return invokePinduoduoDrama<{ reset: number }>(
      "pinduoduo-drama:upload-records:retry-one",
      platformApplyId,
      accountName,
    );
  },
  confirmPublication(accountName: string, id: number, published: boolean) {
    return invokePinduoduoDrama<void>("pinduoduo-drama:upload-records:confirm-publication", accountName, id, published);
  },
};
