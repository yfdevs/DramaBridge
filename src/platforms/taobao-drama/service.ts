export type TaobaoDramaLoginState = "login-required" | "verification-required" | "logged-in" | "unknown"
export type TaobaoDramaAccount = {
  accountId: string; accountName: string; loginAccount?: string | null; status: string
}
export type TaobaoDramaConfig = {
  accountProfileName: string
  apiBaseUrl: string
  browserExecutablePath: string
  headless: string
  operationDelaySeconds: string
  taskPollIntervalSeconds: string
  baiduNetdiskDownloadRetryAttempts: string
  episodeUploadWaitTimeoutMinutes: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
}
export type TaobaoDramaConfigResult = { config: TaobaoDramaConfig; path: string; restartRequired: boolean }
export type TaobaoExecutionAttention = {
  id: string; accountId: string; taskId: number; workerId: string; attemptCount?: number;
  originalTitle?: string; phase: string; errorMessage?: string; updatedAt: string
}
export type TaobaoDramaServiceStatus = {
  platform: "taobao-drama"
  running: boolean
  collectionCreateUrl: string
  batchPublishUrl: string
  loginUrl: string
  accounts: Array<{
    accountId: string; accountName: string; loginAccount?: string | null; launched: boolean
    running: boolean; loginState: TaobaoDramaLoginState; activeUrl?: string; userDataDir: string
    workerId?: string; claimPausedReason?: string
    lastTask?: { accountTaskId: number; originalTitle?: string; status: "running" | "succeeded" | "failed" | "report-pending" | "review-required"; errorMessage?: string; updatedAt: string }
  }>
  executions: TaobaoExecutionAttention[]
  pid: number | null
}
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("淘宝短剧服务仅在 Electron 应用内可用。")
  try { return await window.ipcRenderer.invoke(channel, ...args) as T }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("TAOBAO_DRAMA_ENABLED_ACCOUNT_NOT_FOUND")) throw Object.assign(new Error("没有获取到已启用的淘宝账号，请先在后台开启账号。"), { cause: error })
    throw Object.assign(new Error(message), { cause: error })
  }
}
export const taobaoDramaService = {
  getConfig: () => invoke<TaobaoDramaConfigResult>("taobao-drama:config:get"),
  saveConfig: (config: TaobaoDramaConfig) => invoke<TaobaoDramaConfigResult>("taobao-drama:config:save", config),
  testBrowserPath: (executablePath: string) => invoke<{ ok: boolean; message: string }>("taobao-drama:config:test-browser-path", executablePath),
  status: () => invoke<TaobaoDramaServiceStatus>("taobao-drama:service:status"),
  listAccounts: () => invoke<{ accounts: TaobaoDramaAccount[]; selectedAccountIds: string[] }>("taobao-drama:accounts:list"),
  start: (selectedAccountIds: string[]) => invoke<TaobaoDramaServiceStatus>("taobao-drama:service:start", selectedAccountIds),
  stop: () => invoke<TaobaoDramaServiceStatus>("taobao-drama:service:stop"),
  recheckExecution: (id: string) => invoke<TaobaoDramaServiceStatus>("taobao-drama:execution:recheck", id),
}
