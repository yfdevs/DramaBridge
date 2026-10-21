import type { IpcRendererEvent } from "electron"

export type WechatMiniProgramAccountStatus = {
  videoAccountId: string
  videoAccountName: string
  launched: boolean
  loginState: "not-launched" | "login-required" | "logged-in" | "unknown"
  pageCount: number
  activeUrl?: string
  userDataDir: string
}

export type WechatMiniProgramServiceStatus = {
  running: boolean
  pid: number | null
  videoAccounts: WechatMiniProgramAccountStatus[]
}

export type WechatMiniProgramConfig = {
  apiBaseUrl: string
  taskApiPrefix: string
  catalogApiBaseUrl: string
  localEpisodeVideoRoot: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
  workerEmptyClaimDelaySeconds: string
  workerSlowEmptyClaimThreshold: string
  workerSlowEmptyClaimDelaySeconds: string
  videoAccountSyncIntervalSeconds: string
  catalogAutoSyncIntervalSeconds: string
  idlePageRefreshIntervalSeconds: string
  idlePageRefreshTimeoutSeconds: string
  idlePageRefreshJitterSeconds: string
  basicInfoStepTimeoutSeconds: string
  remoteFileDownloadTimeoutSeconds: string
  baiduNetdiskDownloadRetryAttempts: string
  mergeOwnershipMaterials: string
  materialPreparationConcurrency: string
  taskPrefetchPerAccount: string
  videoTranscodeConcurrency: string
  videoTranscodeThreadsPerJob: string
  episodeVideoMaxFileMegabytes: string
  episodeVideoTargetFileMegabytes: string
  episodeVideoMinimumDurationSeconds: string
  episodeUploadWaitTimeoutSeconds: string
  episodeUploadFailedRetryAttempts: string
}

export type WechatMiniProgramConfigResult = {
  config: WechatMiniProgramConfig
  path: string
  restartRequired: boolean
}

async function invokeWechatMiniProgram<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("微信小程序服务控制仅在 Electron 应用内可用。")
  }

  try {
    const result = await window.ipcRenderer.invoke(channel, ...args)
    return result as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw Object.assign(new Error(readableWechatMiniProgramError(message)), { cause: error })
  }
}

function onWechatMiniProgram<T>(channel: string, listener: (payload: T) => void) {
  if (!window.ipcRenderer) {
    return () => undefined
  }

  const ipcListener = (_event: IpcRendererEvent, payload: T) => listener(payload)
  window.ipcRenderer.on(channel, ipcListener)

  return () => {
    window.ipcRenderer.off(channel, ipcListener)
  }
}

function readableWechatMiniProgramError(message: string) {
  if (message.includes("WECHAT_MINIPROGRAM_LOCAL_VIDEO_ROOT_REQUIRED")) {
    return "请先在微信小程序配置中选择剧集视频根目录。"
  }

  if (message.includes("localEpisodeVideoRoot is required for local episode videos")) {
    return "请先在微信小程序配置中选择剧集视频根目录。"
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

  if (message.includes("微信小程序账号接口至少需要返回一个启用账号")) {
    return "微信小程序账号接口没有返回启用账号，请检查账号接口。"
  }

  return message
}

export const wechatMiniProgramService = {
  getConfig() {
    return invokeWechatMiniProgram<WechatMiniProgramConfigResult>("wechat-miniprogram-drama:config:get")
  },
  saveConfig(config: WechatMiniProgramConfig) {
    return invokeWechatMiniProgram<WechatMiniProgramConfigResult>("wechat-miniprogram-drama:config:save", config)
  },
  onConfigChanged(listener: (result: WechatMiniProgramConfigResult) => void) {
    return onWechatMiniProgram<WechatMiniProgramConfigResult>("wechat-miniprogram-drama:config:changed", listener)
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokeWechatMiniProgram<string | null>(
      "wechat-miniprogram-drama:config:select-local-episode-video-root",
      currentPath
    )
  },
  selectRunDataDir(currentPath?: string) {
    return invokeWechatMiniProgram<string | null>(
      "wechat-miniprogram-drama:config:select-run-data-dir",
      currentPath
    )
  },
  status() {
    return invokeWechatMiniProgram<WechatMiniProgramServiceStatus>("wechat-miniprogram-drama:service:status")
  },
  async start() {
    const { config } = await invokeWechatMiniProgram<WechatMiniProgramConfigResult>(
      "wechat-miniprogram-drama:config:get"
    )
    if (!config.localEpisodeVideoRoot.trim()) {
      throw new Error("请先在微信小程序配置中选择剧集视频根目录。")
    }

    return invokeWechatMiniProgram<WechatMiniProgramServiceStatus>("wechat-miniprogram-drama:service:start")
  },
  stop() {
    return invokeWechatMiniProgram<WechatMiniProgramServiceStatus>("wechat-miniprogram-drama:service:stop")
  },
  focusVideoAccount(videoAccountId: string) {
    return invokeWechatMiniProgram<WechatMiniProgramServiceStatus>(
      "wechat-miniprogram-drama:service:video-account:focus",
      videoAccountId
    )
  },
  openVideoAccountLog(videoAccountId: string) {
    return invokeWechatMiniProgram<string>(
      "wechat-miniprogram-drama:service:video-account:open-log",
      videoAccountId
    )
  },
}
