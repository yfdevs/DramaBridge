import { createAccountControl } from "@/platforms/app-runtime/service";
export type IqiyiDramaLoginState = "login-required" | "logged-in" | "unknown"

export type IqiyiDramaConfig = {
  accountProfileName: string
  apiBaseUrl: string
  localMaterialRoot: string
  baiduNetdiskDownloadRetryAttempts: string
  headless: string
  operationDelaySeconds: string
  taskPollIntervalSeconds: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
}

export type IqiyiDramaStoragePaths = {
  runDataDir: string
  accountDir: string
  userDataDir: string
  credentialStatePath: string
  assetDownloadDir: string
  logDir: string
  logFilePath: string
}

export type IqiyiDramaConfigResult = {
  config: IqiyiDramaConfig
  path: string
  storagePaths: IqiyiDramaStoragePaths
  restartRequired: boolean
}

export type IqiyiDramaServiceStatus = {
  platform: "iqiyi-drama"
  running: boolean
  shortDramaCreateUrl: string
  comicDramaCreateUrl: string
  loginUrl: string
  accounts: Array<{
    accountId: string
    accountName: string
    loginAccount?: string | null
    launched: boolean
    running: boolean
    loginState: IqiyiDramaLoginState
    activeUrl?: string
    userDataDir: string
    lastTask?: {
      accountTaskId: number
      originalTitle?: string
      dramaType?: "short-drama" | "comic-drama"
      status: "running" | "succeeded" | "failed"
      errorMessage?: string
      updatedAt: string
    }
  }>
  pid: number | null
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("爱奇艺服务控制仅在 Electron 应用内可用")
  try {
    return await window.ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const mappings: Array<[string, string]> = [
      ["IQIYI_DRAMA_ENABLED_ACCOUNT_NOT_FOUND", "没有获取到已启用的爱奇艺账号，请先在后台开启账号"],
      ["IQIYI_DRAMA_API_BASE_URL_REQUIRED", "请先配置爱奇艺后台接口地址"],
      ["OWNERSHIP_PROJECT_PROOF_AI_CLIENT_REQUIRED", "存在无法从文件名判断的权属截图，请先在全局配置中填写 AI API Key"],
      ["DRAMA_AI_API_KEY_REQUIRED", "爱奇艺图片处理需要 AI，请先在全局配置中填写 API Key"],
      ["DRAMA_AI_IMAGE_MODEL_REQUIRED", "请先在全局配置中填写图片生成模型 ID"],
    ]
    const readable = mappings.find(([code]) => message.includes(code))?.[1] ?? message
    throw Object.assign(new Error(readable), { cause: error })
  }
}

export const iqiyiDramaService = {
  accountControl: createAccountControl("iqiyi-drama"),
  listAccounts: () => invoke<Array<{ accountId: string; accountName: string }>>("iqiyi-drama:accounts:list"),
  getConfig: () => invoke<IqiyiDramaConfigResult>("iqiyi-drama:config:get"),
  saveConfig: (config: IqiyiDramaConfig) =>
    invoke<IqiyiDramaConfigResult>("iqiyi-drama:config:save", config),
  selectRunDataDir: (current?: string) =>
    invoke<string | null>("iqiyi-drama:config:select-run-data-dir", current),
  selectLocalMaterialRoot: (current?: string) =>
    invoke<string | null>("iqiyi-drama:config:select-local-material-root", current),
  status: () => invoke<IqiyiDramaServiceStatus>("iqiyi-drama:service:status"),
  start: (ids: string[]) => invoke<IqiyiDramaServiceStatus>("iqiyi-drama:service:start", ids),
  stop: () => invoke<IqiyiDramaServiceStatus>("iqiyi-drama:service:stop"),
}
