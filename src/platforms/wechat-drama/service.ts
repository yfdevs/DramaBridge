import type { IpcRendererEvent } from "electron"

export type WechatVideoAccountStatus = {
  videoAccountId: string
  videoAccountName: string
  contractSubject?: string
  contractSubjectLabel?: string
  launched: boolean
  loginState: "not-launched" | "login-required" | "logged-in" | "unknown"
  pageCount: number
  activeUrl?: string
  userDataDir: string
}

export type WechatVideoServiceStatus = {
  running: boolean
  pid: number | null
  contractSubjects: Array<{ label: string; value: string }>
  videoAccounts: WechatVideoAccountStatus[]
}

export type WechatVideoConfig = {
  apiBaseUrl: string
  videoAccountContractSubjects: string
  localEpisodeVideoRoot: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
  workerEmptyClaimDelaySeconds: string
  workerSlowEmptyClaimThreshold: string
  workerSlowEmptyClaimDelaySeconds: string
  videoAccountSyncIntervalSeconds: string
  idlePageRefreshIntervalSeconds: string
  idlePageRefreshTimeoutSeconds: string
  idlePageRefreshJitterSeconds: string
  basicInfoStepTimeoutSeconds: string
  remoteFileDownloadTimeoutSeconds: string
  baiduNetdiskDownloadRetryAttempts: string
  jianyingOwnershipProofCount: string
  juchuangOwnershipProofCount: string
  materialPreparationConcurrency: string
  taskPrefetchPerAccount: string
  videoTranscodeConcurrency: string
  videoTranscodeThreadsPerJob: string
  imageCompressionThresholdMegabytes: string
  imageCompressionTargetMegabytes: string
  episodeVideoMaxFileMegabytes: string
  episodeVideoTargetFileMegabytes: string
  episodeUploadWaitTimeoutSeconds: string
  episodeUploadFailedRetryAttempts: string
  feishuBotWebhookUrl: string
}

export type WechatVideoConfigResult = {
  config: WechatVideoConfig
  path: string
  restartRequired: boolean
}

const contractSubjectLabels: Record<string, string> = {
  MINGXINGSHUO: "明星说",
  MISU: "米苏",
  WEITAO: "微淘",
  HUANZOU: "幻走",
  XIAOSHILIU: "小石榴",
  YOUDIANNIU: "有点牛",
  ZHENCUIYIHAO: "珍萃",
  RUIXIAODOU: "瑞小豆",
}

async function invokeWechatVideo<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("微信视频号服务控制仅在 Electron 应用内可用。")
  }

  try {
    const result = await window.ipcRenderer.invoke(channel, ...args)
    return result as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(readableWechatVideoError(message))
  }
}

function onWechatVideo<T>(channel: string, listener: (payload: T) => void) {
  if (!window.ipcRenderer) {
    return () => undefined
  }

  const ipcListener = (_event: IpcRendererEvent, payload: T) => listener(payload)
  window.ipcRenderer.on(channel, ipcListener)

  return () => {
    window.ipcRenderer.off(channel, ipcListener)
  }
}

function readableWechatVideoError(message: string) {
  if (message.includes("WECHAT_LOCAL_VIDEO_ROOT_REQUIRED")) {
    return "请先在微信视频号配置中选择剧集视频根目录。"
  }

  if (message.includes("localEpisodeVideoRoot is required for local episode videos")) {
    return "请先在微信视频号配置中选择剧集视频根目录。"
  }

  if (message.includes("[local-video-invalid] 剧集视频目录不存在:")) {
    return message.replace("[local-video-invalid] 剧集视频目录不存在:", "微信剧集视频目录不存在：")
  }

  if (message.includes("[local-video-invalid] 存在重复集数:")) {
    return message.replace("[local-video-invalid] 存在重复集数:", "微信剧集视频存在重复集数：")
  }

  if (message.includes("[local-video-invalid] 剧集文件应按文件名匹配")) {
    return message.replace("[local-video-invalid]", "微信剧集视频不正确：")
  }

  const emptyContractSubjectMatch = /Video account list must contain at least one account after contract subject filter: ([^;]+); available contract subjects: (.*)/.exec(message)
  if (emptyContractSubjectMatch) {
    const selectedSubjects = formatContractSubjectList(emptyContractSubjectMatch[1])
    const availableSubjects = formatContractSubjectList(emptyContractSubjectMatch[2])
    return `当前选择的主体没有可用视频号账号：${selectedSubjects}。当前接口返回的可用主体：${availableSubjects}。请在配置页选择已有主体，或让后端为所选主体配置 ON 状态的视频号账号。`
  }

  return message
}

function formatContractSubjectList(value: string) {
  const subjects = value
    .split(",")
    .map((subject) => subject.trim())
    .filter(Boolean)
    .map((subject) => contractSubjectLabels[subject] ?? subject)

  return subjects.length ? subjects.join("、") : "无"
}

export const wechatVideoService = {
  getConfig() {
    return invokeWechatVideo<WechatVideoConfigResult>("wechat-drama:config:get")
  },
  saveConfig(config: WechatVideoConfig) {
    return invokeWechatVideo<WechatVideoConfigResult>("wechat-drama:config:save", config)
  },
  onConfigChanged(listener: (result: WechatVideoConfigResult) => void) {
    return onWechatVideo<WechatVideoConfigResult>("wechat-drama:config:changed", listener)
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokeWechatVideo<string | null>(
      "wechat-drama:config:select-local-episode-video-root",
      currentPath
    )
  },
  selectRunDataDir(currentPath?: string) {
    return invokeWechatVideo<string | null>(
      "wechat-drama:config:select-run-data-dir",
      currentPath
    )
  },
  status() {
    return invokeWechatVideo<WechatVideoServiceStatus>("wechat-drama:service:status")
  },
  async start() {
    const { config } = await invokeWechatVideo<WechatVideoConfigResult>(
      "wechat-drama:config:get"
    )
    if (!config.localEpisodeVideoRoot.trim()) {
      throw new Error("请先在微信视频号配置中选择剧集视频根目录。")
    }

    return invokeWechatVideo<WechatVideoServiceStatus>("wechat-drama:service:start")
  },
  stop() {
    return invokeWechatVideo<WechatVideoServiceStatus>("wechat-drama:service:stop")
  },
  focusVideoAccount(videoAccountId: string) {
    return invokeWechatVideo<WechatVideoServiceStatus>(
      "wechat-drama:service:video-account:focus",
      videoAccountId
    )
  },
  openVideoAccountLog(videoAccountId: string) {
    return invokeWechatVideo<string>(
      "wechat-drama:service:video-account:open-log",
      videoAccountId
    )
  },
}
