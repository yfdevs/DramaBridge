export type TencentHuolongDramaLoginState = "login-required" | "logged-in" | "unknown"

export type TencentHuolongDramaConfig = {
  accountProfileName: string
  apiBaseUrl: string
  localMaterialRoot: string
  baiduNetdiskDownloadRetryAttempts: string
  episodeUploadWaitTimeoutMinutes: string
  episodeUploadFailedRetryAttempts: string
  headless: string
  operationDelaySeconds: string
  taskPollIntervalSeconds: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
}

export type TencentHuolongDramaStoragePaths = {
  runDataDir: string
  accountDir: string
  userDataDir: string
  credentialStatePath: string
  assetDownloadDir: string
  logDir: string
  logFilePath: string
}

export type TencentHuolongDramaConfigResult = {
  config: TencentHuolongDramaConfig
  path: string
  storagePaths: TencentHuolongDramaStoragePaths
  restartRequired: boolean
}

export type TencentHuolongDramaServiceStatus = {
  platform: "tencent-huolong-drama"
  running: boolean
  addUrl: string
  loginUrl: string
  accounts: Array<{
    accountId: string
    accountName: string
    loginAccount?: string | null
    launched: boolean
    loginState: TencentHuolongDramaLoginState
    activeUrl?: string
    userDataDir: string
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

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("腾讯火龙漫剧服务仅在 Electron 应用内可用。")
  return await window.ipcRenderer.invoke(channel, ...args) as T
}

export const tencentHuolongDramaService = {
  listAccounts: () => invoke<Array<{ accountId: string; accountName: string }>>("tencent-huolong-drama:accounts:list"),
  getConfig: () => invoke<TencentHuolongDramaConfigResult>("tencent-huolong-drama:config:get"),
  saveConfig: (config: TencentHuolongDramaConfig) =>
    invoke<TencentHuolongDramaConfigResult>("tencent-huolong-drama:config:save", config),
  status: () => invoke<TencentHuolongDramaServiceStatus>("tencent-huolong-drama:service:status"),
  start: (ids: string[]) => invoke<TencentHuolongDramaServiceStatus>("tencent-huolong-drama:service:start", ids),
  stop: () => invoke<TencentHuolongDramaServiceStatus>("tencent-huolong-drama:service:stop"),
}
