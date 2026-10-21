export type TiktokDramaCenterLoginState = "login-required" | "logged-in" | "unknown"

export type TiktokDramaCenterConfig = {
  headless: string
  localEpisodeVideoRoot: string
  operationDelaySeconds: string
  runDataDir: string
}

export type TiktokDramaCenterConfigResult = {
  config: TiktokDramaCenterConfig
  path: string
  restartRequired: boolean
}

export type TiktokDramaCenterServiceStatus = {
  platform: "tiktok-drama"
  running: boolean
  loginState: TiktokDramaCenterLoginState
  activeUrl?: string
  userDataDir: string
  pid: number | null
}

async function invokeTiktokDramaCenter<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("TikTok 服务控制仅在 Electron 应用内可用。")
  }

  try {
    const result = await window.ipcRenderer.invoke(channel, ...args)
    return result as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw Object.assign(new Error(readableTiktokDramaCenterError(message)), { cause: error })
  }
}

function readableTiktokDramaCenterError(message: string) {
  if (message.includes("TIKTOK_LOCAL_VIDEO_ROOT_REQUIRED")) {
    return "请先在 TikTok 配置中选择剧集视频根目录。"
  }

  if (message.includes("video root is required")) {
    return "请先在 TikTok 配置中选择剧集视频根目录。"
  }

  if (message.includes("video directory not found:")) {
    return message.replace("video directory not found:", "TikTok 剧集视频目录不存在：")
  }

  if (message.includes("missing episodes:")) {
    return message.replace("missing episodes:", "TikTok 剧集视频缺少集数：")
  }

  if (message.includes("duplicate episode")) {
    return message.replace("duplicate episode", "TikTok 剧集视频存在重复集数")
  }

  return message
}

export const tiktokDramaCenterService = {
  getConfig() {
    return invokeTiktokDramaCenter<TiktokDramaCenterConfigResult>(
      "tiktok-drama:config:get"
    )
  },
  saveConfig(config: TiktokDramaCenterConfig) {
    return invokeTiktokDramaCenter<TiktokDramaCenterConfigResult>(
      "tiktok-drama:config:save",
      config
    )
  },
  selectRunDataDir(currentPath?: string) {
    return invokeTiktokDramaCenter<string | null>(
      "tiktok-drama:config:select-run-data-dir",
      currentPath
    )
  },
  selectLocalEpisodeVideoRoot(currentPath?: string) {
    return invokeTiktokDramaCenter<string | null>(
      "tiktok-drama:config:select-local-episode-video-root",
      currentPath
    )
  },
  status() {
    return invokeTiktokDramaCenter<TiktokDramaCenterServiceStatus>(
      "tiktok-drama:service:status"
    )
  },
  start() {
    return invokeTiktokDramaCenter<TiktokDramaCenterServiceStatus>(
      "tiktok-drama:service:start"
    )
  },
  stop() {
    return invokeTiktokDramaCenter<TiktokDramaCenterServiceStatus>(
      "tiktok-drama:service:stop"
    )
  },
}
