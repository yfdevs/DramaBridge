export type DouyinDramaLoginState = "login-required" | "logged-in" | "unknown"

export type DouyinDramaConfig = {
  apiBaseUrl: string
  localEpisodeVideoRoot: string
  baiduNetdiskDownloadRetryAttempts: string
  episodeUploadReplaceAttempts: string
  episodeUploadBatchSize: string
  episodeUploadWaitTimeoutMinutes: string
  unitPriceYuan: string
  paidEpisodeStart: string
  headless: string
  operationDelaySeconds: string
  taskPollIntervalSeconds: string
  runDataDir: string
  logRetentionDays: string
  closeFailedTaskPages: string
}

export type DouyinDramaConfigResult = {
  config: DouyinDramaConfig
  path: string
  restartRequired: boolean
}

export type DouyinDramaServiceStatus = {
  platform: "douyin-drama"
  running: boolean
  createUrl: string
  loginUrl: string
  accounts: Array<{
    id: number
    accountId: string
    accountName: string
    loginAccount?: string | null
    rpaProfileKey?: string | null
    launched: boolean
    running: boolean
    loginState: DouyinDramaLoginState
    activeUrl?: string
    userDataDir: string
    lastTask?: {
      accountTaskId: number
      originalTitle: string
      status: "running" | "succeeded" | "failed"
      errorMessage?: string
      updatedAt: string
    }
  }>
  pid: number | null
}

async function invokeDouyinDrama<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("抖音短剧服务控制仅在 Electron 应用内可用。")
  }
  try {
    return await window.ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const readableMessage = message.includes("DOUYIN_DRAMA_LOCAL_VIDEO_ROOT_REQUIRED")
      ? "请先选择抖音短剧剧集视频根目录。"
      : message.includes("DOUYIN_DRAMA_ENABLED_ACCOUNT_NOT_FOUND")
        ? "没有获取到已启用的抖音账号，请先在后台开启账号。"
        : message.includes("DOUYIN_DRAMA_API_BASE_URL_REQUIRED")
          ? "请先配置抖音后台接口地址。"
      : message
    const readableError = new Error(readableMessage) as Error & { cause?: unknown }
    readableError.cause = error
    throw readableError
  }
}

export const douyinDramaService = {
  getConfig: () => invokeDouyinDrama<DouyinDramaConfigResult>("douyin-drama:config:get"),
  saveConfig: (config: DouyinDramaConfig) =>
    invokeDouyinDrama<DouyinDramaConfigResult>("douyin-drama:config:save", config),
  selectRunDataDir: (currentPath?: string) =>
    invokeDouyinDrama<string | null>("douyin-drama:config:select-run-data-dir", currentPath),
  selectLocalEpisodeVideoRoot: (currentPath?: string) =>
    invokeDouyinDrama<string | null>(
      "douyin-drama:config:select-local-episode-video-root",
      currentPath,
    ),
  status: () => invokeDouyinDrama<DouyinDramaServiceStatus>("douyin-drama:service:status"),
  listAccounts: () => invokeDouyinDrama<Array<{ accountId: string; accountName: string }>>("douyin-drama:accounts:list"),
  start: (ids: string[]) => invokeDouyinDrama<DouyinDramaServiceStatus>("douyin-drama:service:start", ids),
  stop: () => invokeDouyinDrama<DouyinDramaServiceStatus>("douyin-drama:service:stop"),
}
