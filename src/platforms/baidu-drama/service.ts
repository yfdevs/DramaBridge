export type BaiduDramaLoginState = "login-required" | "logged-in" | "unknown"

export type BaiduDramaConfig = {
  apiBaseUrl: string
  localEpisodeVideoRoot: string
  baiduNetdiskDownloadRetryAttempts: string
  episodeUploadWaitTimeoutMinutes: string
  headless: string
  operationDelaySeconds: string
  taskPollIntervalSeconds: string
  runDataDir: string
  logRetentionDays: string
}

export type BaiduDramaConfigResult = {
  config: BaiduDramaConfig
  path: string
  restartRequired: boolean
}

export type BaiduDramaServiceStatus = {
  platform: "baidu-drama"
  running: boolean
  createUrl: string
  loginUrl: string
  accounts: Array<{
    accountId: string
    accountName: string
    loginAccount?: string | null
    launched: boolean
    loginState: BaiduDramaLoginState
    activeUrl?: string
    userDataDir: string
    taskClaimResumeAt?: number
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

function readableBaiduDramaError(message: string) {
  if (message.includes("BAIDU_DRAMA_ENABLED_ACCOUNT_NOT_FOUND")) {
    return "没有获取到已启用的百度账号，请先在后台开启账号。"
  }
  if (message.includes("BAIDU_DRAMA_API_BASE_URL_REQUIRED")) {
    return "请先配置百度后台接口地址。"
  }
  if (message.includes("BAIDU_DRAMA_ACCOUNT_CONFIG_RESPONSE_DATA_REQUIRED")) {
    return "百度账号列表响应缺少 data，请检查接口地址。"
  }
  const requestFailed = message.match(/BAIDU_DRAMA_ACCOUNT_CONFIG_REQUEST_FAILED: (.*)/)
  if (requestFailed) return `百度账号列表获取失败：${requestFailed[1]}`
  return message
}

async function invokeBaiduDrama<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("百度短剧服务控制仅在 Electron 应用内可用。")
  try {
    return await window.ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const readableMessage = message.includes("BAIDU_DRAMA_LOCAL_VIDEO_ROOT_REQUIRED")
      ? "请先选择百度短剧剧集视频根目录。"
      : readableBaiduDramaError(message)
    const readableError = new Error(readableMessage) as Error & { cause?: unknown }
    readableError.cause = error
    throw readableError
  }
}

export const baiduDramaService = {
  getConfig: () => invokeBaiduDrama<BaiduDramaConfigResult>("baidu-drama:config:get"),
  saveConfig: (config: BaiduDramaConfig) =>
    invokeBaiduDrama<BaiduDramaConfigResult>("baidu-drama:config:save", config),
  selectRunDataDir: (currentPath?: string) =>
    invokeBaiduDrama<string | null>("baidu-drama:config:select-run-data-dir", currentPath),
  selectLocalEpisodeVideoRoot: (currentPath?: string) =>
    invokeBaiduDrama<string | null>("baidu-drama:config:select-local-episode-video-root", currentPath),
  status: () => invokeBaiduDrama<BaiduDramaServiceStatus>("baidu-drama:service:status"),
  start: () => invokeBaiduDrama<BaiduDramaServiceStatus>("baidu-drama:service:start"),
  stop: () => invokeBaiduDrama<BaiduDramaServiceStatus>("baidu-drama:service:stop"),
}
