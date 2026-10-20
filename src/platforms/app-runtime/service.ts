import type { IpcRendererEvent } from "electron";
import type { PlatformId } from "@/config/navigation";

export type AppBrowserInstanceSummary = {
  id: string;
  label: string;
  loginState?: string;
  activeUrl?: string;
};

export type AppPlatformRuntimeSummary = {
  platform: PlatformId;
  running: boolean;
  startedAt: number | null;
  browserInstanceCount: number;
  browserInstances: AppBrowserInstanceSummary[];
  logDir: string;
};

export type AppPlatformRuntimeResult = {
  appVersion: string;
  platform: AppPlatformRuntimeSummary;
};

export type AppUpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type AppUpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type AppUpdateSourceId =
  | "accelerated"
  | "github"
  | "github-dpik-top"
  | "gh-proxy-com"
  | "github-tbap-top"
  | "memory-echoes"
  | "gh-dpik-top"
  | "geekertao"
  | "ghproxy-net";
export type AppUpdateSourceMode = "auto" | "manual";
export type AppUpdateSourceSelection = "auto" | AppUpdateSourceId;

export type AppUpdateSource = {
  id: AppUpdateSourceId;
  label: string;
  description: string;
  url: string;
};

export type AppUpdateStatus = {
  state: AppUpdateState;
  supported: boolean;
  enabled: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  progress?: AppUpdateProgress;
  error?: string;
  disabledReason?: string;
  sourceMode: AppUpdateSourceMode;
  source: AppUpdateSource;
  sources: AppUpdateSource[];
  lastCheckedAt?: string;
  nextCheckAt?: string;
  retryAttempt?: number;
  runningPlatformCount: number;
  updatedAt: string;
};

export type AppUpdateInstallOptions = {
  stopRunningServices?: boolean;
};

function requireIpcRenderer(action: string) {
  if (!window.ipcRenderer) {
    throw new Error(`${action}仅在 Electron 应用内可用。`);
  }

  return window.ipcRenderer;
}

export function getAppPlatformRuntime(platformId: PlatformId) {
  return requireIpcRenderer("平台运行状态").invoke(
    "app:platform:runtime",
    platformId,
  ) as Promise<AppPlatformRuntimeResult>;
}

export function openAppPlatformLogs(platformId: PlatformId) {
  return requireIpcRenderer("打开日志目录").invoke(
    "app:platform:open-logs",
    platformId,
  ) as Promise<string>;
}

export function getAppUpdateStatus() {
  return requireIpcRenderer("应用更新状态").invoke("app:update:status") as Promise<AppUpdateStatus>;
}

export function checkForAppUpdate() {
  return requireIpcRenderer("检查应用更新").invoke("app:update:check") as Promise<AppUpdateStatus>;
}

export function downloadAppUpdate() {
  return requireIpcRenderer("下载应用更新").invoke(
    "app:update:download",
  ) as Promise<AppUpdateStatus>;
}

export function cancelAppUpdateDownload() {
  return requireIpcRenderer("取消应用更新下载").invoke(
    "app:update:download:cancel",
  ) as Promise<AppUpdateStatus>;
}

export function installAppUpdate(options?: AppUpdateInstallOptions) {
  return requireIpcRenderer("安装应用更新").invoke(
    "app:update:install",
    options,
  ) as Promise<AppUpdateStatus>;
}

export function setAppUpdateSource(selection: AppUpdateSourceSelection) {
  return requireIpcRenderer("切换应用更新源").invoke(
    "app:update:source:set",
    selection,
  ) as Promise<AppUpdateStatus>;
}

export function onAppUpdateChanged(listener: (status: AppUpdateStatus) => void) {
  if (!window.ipcRenderer) {
    return () => undefined;
  }

  const ipcListener = (_event: IpcRendererEvent, nextStatus: AppUpdateStatus) => {
    listener(nextStatus);
  };

  window.ipcRenderer.on("app:update:changed", ipcListener);

  return () => {
    window.ipcRenderer.off("app:update:changed", ipcListener);
  };
}
