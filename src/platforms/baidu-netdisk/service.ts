export const BAIDU_NETDISK_DEFAULT_DOWNLOAD_DIR = "D:\\BaiduNetdiskDownload";

export type BaiduNetdiskConfig = {
  debugPort: string;
  executablePath: string;
};

export type BaiduNetdiskConfigResult = {
  config: BaiduNetdiskConfig;
  path: string;
};

export type BaiduNetdiskCdpStatus = {
  platform: "baidu-netdisk";
  isWindows: boolean;
  port: number;
  appRunning: boolean;
  cdpRunning: boolean;
  ready: boolean;
  executablePath?: string;
  targetCount: number;
  checkedAt: string;
  message: string;
};

export type BaiduNetdiskLaunchResult = {
  status: BaiduNetdiskCdpStatus;
  executablePath: string;
  restarted: boolean;
};

export type BaiduNetdiskShareInfo = {
  link: string;
  pwd: string;
  name: string;
};

export type BaiduNetdiskRemoteEpisodeFile = {
  index: number;
  name: string;
  path: string;
  size?: number;
};

export type BaiduNetdiskRemoteVideoListing = {
  rootPath: string;
  files: BaiduNetdiskRemoteEpisodeFile[];
  allVideoFiles: Array<{
    name: string;
    path: string;
    size?: number;
  }>;
  duplicateIndexes: number[];
  missingIndexes?: number[];
};

export type BaiduNetdiskShareDownloadResult = {
  share: BaiduNetdiskShareInfo;
  downloadRoot?: string;
  localPath?: string;
  expectedOwnershipImages?: number;
  expectedPosterImages?: number;
  remoteVideos?: BaiduNetdiskRemoteVideoListing;
  completed: boolean;
  skippedExisting: boolean;
  downloadDir: string;
};

export type BaiduNetdiskDownloadState = "pending" | "downloading" | "completed" | "failed";

export type BaiduNetdiskDownloadRecord = {
  id: string;
  shareKey: string;
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot?: string;
  episodeCount?: number;
  downloadDir: string;
  localPath?: string;
  progressPercent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedText?: string;
  nativeStatus?: string;
  state: BaiduNetdiskDownloadState;
  skippedExisting: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  remoteTransferPath?: string;
  remoteTransferFsId?: string;
  remoteTransferOwned?: boolean;
  remoteCleanupPending?: boolean;
  remoteCleanupError?: string;
};

export type BaiduNetdiskEnsureDownloadedRequest = {
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot: string;
  episodeCount: number;
  requiredOwnership?: {
    minimumImages?: number;
  };
  requiredPosterImages?: number;
  mergeOwnershipMaterials?: boolean;
  videoTranscode?: {
    runDataDir: string;
    maxFileMegabytes: number;
    targetFileMegabytes: number;
    concurrency: number;
    threadsPerJob: number;
  };
};

export type BaiduNetdiskDownloadRecordResult = {
  records: BaiduNetdiskDownloadRecord[];
  path: string;
};

function trimShareLink(value: string) {
  return value.replace(/[),，。；;、\]]+$/g, "");
}

function sanitizeWindowsName(value: string) {
  const sanitized = value.replace(/[\\/:*?"<>|]/g, "_").trim();
  return sanitized || "百度网盘分享";
}

export function parseBaiduNetdiskShareText(text: string): BaiduNetdiskShareInfo | null {
  const link = trimShareLink(text.match(/https?:\/\/pan\.baidu\.com\/s\/[^\s"'<>]+/)?.[0] ?? "");

  if (!link) {
    return null;
  }

  let pwd: string | null | undefined;
  try {
    pwd = new URL(link).searchParams.get("pwd");
  } catch {
    pwd = null;
  }

  pwd ??= text.match(/(?:提取码|密码|pwd)[:：\s]*([a-zA-Z0-9]{4})/)?.[1];
  if (!pwd) {
    return null;
  }

  const name =
    text.match(/通过网盘分享的文件[:：]\s*([^\r\n]+)/)?.[1]?.trim() ??
    text.match(/分享的文件[:：]\s*([^\r\n]+)/)?.[1]?.trim() ??
    "百度网盘分享";

  return { link, pwd, name: sanitizeWindowsName(name) };
}

function requireIpcRenderer(feature: string) {
  if (!window.ipcRenderer) {
    throw new Error(`${feature}仅在 Electron 应用内可用。`);
  }

  return window.ipcRenderer;
}

export async function getBaiduNetdiskStatus() {
  return requireIpcRenderer("百度网盘状态").invoke(
    "baidu-netdisk:service:status",
  ) as Promise<BaiduNetdiskCdpStatus>;
}

export async function getBaiduNetdiskConfig() {
  return requireIpcRenderer("百度网盘配置").invoke(
    "baidu-netdisk:config:get",
  ) as Promise<BaiduNetdiskConfigResult>;
}

export async function saveBaiduNetdiskConfig(config: Partial<BaiduNetdiskConfig>) {
  return requireIpcRenderer("保存百度网盘配置").invoke(
    "baidu-netdisk:config:save",
    config,
  ) as Promise<BaiduNetdiskConfigResult>;
}

export async function selectBaiduNetdiskExecutable() {
  return requireIpcRenderer("选择百度网盘安装目录").invoke(
    "baidu-netdisk:config:select-executable",
  ) as Promise<BaiduNetdiskConfigResult | null>;
}

export async function controlBaiduNetdiskCdp(restart: boolean) {
  return requireIpcRenderer("百度网盘 CDP 控制").invoke(
    restart ? "baidu-netdisk:service:restart-cdp" : "baidu-netdisk:service:start-cdp",
  ) as Promise<BaiduNetdiskLaunchResult>;
}

export async function downloadBaiduNetdiskShare(shareText: string) {
  return requireIpcRenderer("百度网盘下载").invoke("baidu-netdisk:share:download", {
    shareText,
  }) as Promise<BaiduNetdiskShareDownloadResult>;
}

export async function ensureBaiduNetdiskShareDownloaded(
  request: BaiduNetdiskEnsureDownloadedRequest,
) {
  return requireIpcRenderer("百度网盘下载").invoke(
    "baidu-netdisk:share:ensure-downloaded",
    request,
  ) as Promise<BaiduNetdiskDownloadRecord>;
}

export async function getBaiduNetdiskDownloadRecords() {
  return requireIpcRenderer("百度网盘下载记录").invoke(
    "baidu-netdisk:downloads:list",
  ) as Promise<BaiduNetdiskDownloadRecordResult>;
}

export async function clearBaiduNetdiskDownloadRecords() {
  return requireIpcRenderer("清空百度网盘下载记录").invoke(
    "baidu-netdisk:downloads:clear",
  ) as Promise<BaiduNetdiskDownloadRecordResult>;
}

export async function controlBaiduNetdiskDownloadTask(targetName: string, action: "pause" | "resume" | "delete") {
  return requireIpcRenderer("百度网盘下载任务控制").invoke("baidu-netdisk:downloads:control", { targetName, action }) as Promise<boolean>;
}

export function onBaiduNetdiskDownloadRecordsChanged(
  listener: (result: BaiduNetdiskDownloadRecordResult) => void,
) {
  if (!window.ipcRenderer) {
    return () => undefined;
  }

  const ipcListener = (_event: unknown, result: BaiduNetdiskDownloadRecordResult) => {
    listener(result);
  };

  window.ipcRenderer.on("baidu-netdisk:downloads:changed", ipcListener);

  return () => {
    window.ipcRenderer.off("baidu-netdisk:downloads:changed", ipcListener);
  };
}
