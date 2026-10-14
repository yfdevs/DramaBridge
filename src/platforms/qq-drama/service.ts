export type QqDramaLoginState = "login-required" | "logged-in" | "unknown"

export type QqDramaConfig = {
  accountProfileName: string
  apiBaseUrl: string
  localEpisodeVideoRoot: string
  baiduNetdiskDownloadRetryAttempts: string
  episodeUploadWaitTimeoutMinutes: string
  episodeUploadFailedRetryAttempts: string
  acceptSecondVersion: string
  headless: string
  operationDelaySeconds: string
  taskPollIntervalSeconds: string
  runDataDir: string
  logRetentionDays: string
}

export type QqDramaStoragePaths = {
  runDataDir: string
  accountDir: string
  userDataDir: string
  credentialStatePath: string
  assetDownloadDir: string
  logDir: string
  logFilePath: string
}

export type QqDramaStoragePathKey = keyof QqDramaStoragePaths | "configFilePath" | "latestLog"

export type QqDramaConfigResult = {
  config: QqDramaConfig
  path: string
  storagePaths: QqDramaStoragePaths
  restartRequired: boolean
}

export type QqDramaServiceStatus = {
  platform: "qq-drama"
  running: boolean
  addUrl: string
  loginUrl: string
  accounts: Array<{
    accountId: string
    accountName: string
    loginAccount?: string | null
    launched: boolean
    loginState: QqDramaLoginState
    activeUrl?: string
    userDataDir: string
    accountDir?: string
    credentialStatePath?: string
    assetDownloadDir?: string
    logFilePath?: string
    lastTask?: {
      accountTaskId: number
      originalTitle?: string
      status: "running" | "succeeded" | "failed"
      errorMessage?: string
      updatedAt: string
    }
  }>
  pid: number | null
}

async function invokeQqDrama<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("QQ 短剧服务控制仅在 Electron 应用内可用。")
  }

  try {
    const result = await window.ipcRenderer.invoke(channel, ...args)
    return result as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const readableError = new Error(readableQqDramaError(message)) as Error & {
      cause?: unknown
    }
    readableError.cause = error
    throw readableError
  }
}

function readableQqDramaError(message: string) {
  if (message.includes("QQ_DRAMA_ENABLED_ACCOUNT_NOT_FOUND")) {
    return "没有获取到已启用的 QQ 账号，请先在后台开启账号。"
  }
  if (message.includes("QQ_DRAMA_API_BASE_URL_REQUIRED")) {
    return "请先配置 QQ 后台接口地址。"
  }
  if (message.includes("QQ_DRAMA_ACCOUNT_CONFIG_RESPONSE_DATA_REQUIRED")) {
    return "QQ 账号列表响应缺少 data，请检查登录状态和接口地址。"
  }
  const requestFailed = message.match(/QQ_DRAMA_ACCOUNT_CONFIG_REQUEST_FAILED: (.*)/)
  if (requestFailed) {
    return `QQ 账号列表获取失败：${requestFailed[1]}`
  }
  return message
}

export const qqDramaService = {
  getConfig() {
    return invokeQqDrama<QqDramaConfigResult>("qq-drama:config:get")
  },
  saveConfig(config: QqDramaConfig) {
    return invokeQqDrama<QqDramaConfigResult>("qq-drama:config:save", config)
  },
  selectRunDataDir(currentPath?: string) {
    return invokeQqDrama<string | null>("qq-drama:config:select-run-data-dir", currentPath)
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokeQqDrama<string | null>(
      "qq-drama:config:select-local-episode-video-root",
      currentPath
    )
  },
  openStoragePath(key: QqDramaStoragePathKey) {
    return invokeQqDrama<string>("qq-drama:config:open-storage-path", key)
  },
  status() {
    return invokeQqDrama<QqDramaServiceStatus>("qq-drama:service:status")
  },
  start() {
    return invokeQqDrama<QqDramaServiceStatus>("qq-drama:service:start")
  },
  stop() {
    return invokeQqDrama<QqDramaServiceStatus>("qq-drama:service:stop")
  },
}
