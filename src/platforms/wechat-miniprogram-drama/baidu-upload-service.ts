import type { IpcRendererEvent } from "electron"

export type WechatMiniProgramDirectUploadTaskState =
  | "queued"
  | "inspecting"
  | "downloading"
  | "waiting-login"
  | "uploading"
  | "completed"
  | "failed"
  | "interrupted"

export type WechatMiniProgramDirectUploadTask = {
  id: string
  queueOrder: number
  dramaName: string
  shareText: string
  shareKey: string
  state: WechatMiniProgramDirectUploadTaskState
  inferredEpisodeCount?: number
  episodeIndexes?: number[]
  localPath?: string
  uploadCompletedCount: number
  uploadTotalCount: number
  uploadAccountLabel?: string
  error?: string
  retryCount: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export type WechatMiniProgramDirectUploadWorkspace = {
  queue: {
    running: boolean
    activeTaskId?: string
    error?: string
  }
  browser: {
    launched: boolean
    loginState: "not-launched" | "login-required" | "logged-in" | "unknown"
    activeUrl?: string
  }
  tasks: WechatMiniProgramDirectUploadTask[]
  databasePath: string
}

function ipc() {
  if (!window.ipcRenderer) {
    throw new Error("百度资源直传仅在 Electron 应用内可用")
  }
  return window.ipcRenderer
}

async function invoke(channel: string, ...args: unknown[]) {
  return ipc().invoke(channel, ...args) as Promise<WechatMiniProgramDirectUploadWorkspace>
}

export const wechatMiniProgramBaiduUploadService = {
  openWindow() {
    return invoke("wechat-miniprogram-drama:baidu-upload:window:open")
  },
  workspace() {
    return invoke("wechat-miniprogram-drama:baidu-upload:workspace:get")
  },
  createTask(input: { dramaName: string; shareText: string }) {
    return invoke("wechat-miniprogram-drama:baidu-upload:task:create", input)
  },
  retryTask(id: string) {
    return invoke("wechat-miniprogram-drama:baidu-upload:task:retry", id)
  },
  deleteTask(id: string) {
    return invoke("wechat-miniprogram-drama:baidu-upload:task:delete", id)
  },
  startQueue() {
    return invoke("wechat-miniprogram-drama:baidu-upload:queue:start")
  },
  pauseQueue() {
    return invoke("wechat-miniprogram-drama:baidu-upload:queue:pause")
  },
  cancelActiveTask() {
    return invoke("wechat-miniprogram-drama:baidu-upload:task:cancel-active")
  },
  focusBrowser() {
    return invoke("wechat-miniprogram-drama:baidu-upload:browser:focus")
  },
  closeBrowser() {
    return invoke("wechat-miniprogram-drama:baidu-upload:browser:close")
  },
  onWorkspaceChanged(listener: (workspace: WechatMiniProgramDirectUploadWorkspace) => void) {
    if (!window.ipcRenderer) return () => undefined
    const ipcListener = (_event: IpcRendererEvent, workspace: WechatMiniProgramDirectUploadWorkspace) => {
      listener(workspace)
    }
    window.ipcRenderer.on(
      "wechat-miniprogram-drama:baidu-upload:workspace:changed",
      ipcListener,
    )
    return () => {
      window.ipcRenderer.off(
        "wechat-miniprogram-drama:baidu-upload:workspace:changed",
        ipcListener,
      )
    }
  },
}
