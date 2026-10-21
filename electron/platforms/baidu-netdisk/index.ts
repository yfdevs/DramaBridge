import { emitIpcEvent, trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import {
  ensureAiPoster,
  selectBaiduEpisodePathsWithAi,
  VideoTranscodeQueue,
} from "@dramabridge/media-assets";
import { ensureBaiduNetdiskEpisodeVideos } from "@dramabridge/media-assets/baidu-netdisk";
import { formatDateKey } from "@dramabridge/automation-logging";
import { createHash } from "node:crypto";
import { lstat, readdir, rm, statfs, utimes } from "node:fs/promises";
import path from "node:path";
import {
  BaiduNetdiskDownloadRecordsRepository,
  type BaiduNetdiskDownloadRecord,
  type BaiduNetdiskDownloadState,
} from "../../storage/baidu-netdisk";
import {
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  getConfiguredBaiduNetdiskDownloadTimeoutMs,
  isAiPosterFallbackEnabled,
  isBaiduNetdiskPlayletCleanupEnabled,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";
import { resolveFromAppRoot, selectDirectory } from "../shared";
import { createElectronPlatformLogger } from "../../platform-logger";
import { runRuntimeAssetCleanup } from "../../runtime-asset-cleanup";

export type BaiduNetdiskConfig = {
  debugPort: string;
  executablePath: string;
};

type BaiduNetdiskStore = {
  config: Partial<BaiduNetdiskConfig> & Record<string, string | undefined>;
};

type BaiduNetdiskCdpStatus = {
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

type BaiduNetdiskLaunchResult = {
  status: BaiduNetdiskCdpStatus;
  executablePath: string;
  restarted: boolean;
};

type BaiduNetdiskConfigResult = {
  config: BaiduNetdiskConfig;
  path: string;
};

type BaiduNetdiskShareInfo = {
  link: string;
  pwd: string;
  name: string;
};

type BaiduNetdiskRemoteEpisodeFile = {
  index: number;
  name: string;
  path: string;
  size?: number;
};

type BaiduNetdiskRemoteVideoListing = {
  rootPath: string;
  files: BaiduNetdiskRemoteEpisodeFile[];
  allVideoFiles: Array<{
    name: string;
    path: string;
    size?: number;
  }>;
  scannedDirs?: Array<{
    path: string;
    errno?: number;
    count: number;
    hasMore?: boolean;
    entries: Array<{
      name: string;
      path: string;
      isDir: boolean;
      size?: number;
    }>;
  }>;
  duplicateIndexes: number[];
  missingIndexes?: number[];
  aiSelectionApplied?: boolean;
};

type BaiduNetdiskShareDownloadResult = {
  share: BaiduNetdiskShareInfo;
  downloadRoot?: string;
  localPath?: string;
  expectedOwnershipImages?: number;
  expectedOwnershipFiles?: number;
  expectedPosterImages?: number;
  expectedAiProductionProofFiles?: number;
  expectedMetadataTextFiles?: number;
  expectedMetadataFiles?: number;
  remoteVideos?: BaiduNetdiskRemoteVideoListing;
  remoteMetadata?: {
    files: Array<{ name: string; path: string; size?: number }>;
    textFiles: Array<{ name: string; path: string; size?: number }>;
    roots: Array<{ path: string; fsId?: number | string }>;
  };
  inferredEpisodeCount?: number;
  temporaryTransfer?: {
    path: string;
    fsId: number | string;
    createdByAutomation: true;
  };
  remoteResourceRoot?: {
    path: string;
    fsId: number | string;
  };
  completed: boolean;
  skippedExisting: boolean;
  downloadDir: string;
};

type BaiduNetdiskShareDownloadRequest = {
  shareText?: string;
};

export type { BaiduNetdiskDownloadRecord, BaiduNetdiskDownloadState };

export type BaiduNetdiskEnsureDownloadedRequest = {
  requesterPlatform?: string;
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot: string;
  episodeCount?: number;
  episodeDownloadLimit?: number;
  inferEpisodeCount?: boolean;
  downloadEpisodeVideos?: boolean;
  downloadAssetMaterials?: boolean;
  forceAssetDownload?: boolean;
  requireAllDiscoveredAssets?: boolean;
  requiredOwnership?: {
    minimumImages?: number;
  };
  requiredOwnershipFiles?: number;
  requiredPosterImages?: number;
  posterFallback?: {
    title?: string;
    summary: string;
  };
  requiredAiProductionProofFiles?: number;
  requiredMetadataTextFiles?: number;
  mergeOwnershipMaterials?: boolean;
  videoTranscode?: {
    runDataDir: string;
    maxFileMegabytes: number;
    targetFileMegabytes: number;
    concurrency: number;
    threadsPerJob: number;
  };
  signal?: AbortSignal;
  onStableEpisodeFiles?: (files: Array<{
    index: number;
    file: string;
    size: number;
    modifiedAtMs: number;
  }>) => void;
};

function baiduNetdiskRunDataDir() {
  return resolveGlobalPlatformDirectories("baidu-netdisk", {
    runDataDir: resolveFromAppRoot(".drama-runs/baidu-netdisk"),
    localMaterialRoot: defaultBaiduNetdiskDownloadDir,
  }).runDataDir;
}

function baiduNetdiskLogDir() {
  return path.join(baiduNetdiskRunDataDir(), "logs");
}

function baiduNetdiskLogFilePath() {
  return path.join(baiduNetdiskLogDir(), `app-${formatDateKey()}.json`);
}

function baiduNetdiskLogger(
  scope = "netdisk",
  context?: Record<string, unknown>,
) {
  return createElectronPlatformLogger({
    platform: "baidu-netdisk",
    scope,
    context,
    logDir: baiduNetdiskLogDir(),
    retentionDays: 3,
  });
}

export type BaiduNetdiskDownloadRecordResult = {
  records: BaiduNetdiskDownloadRecord[];
  path: string;
};

const defaultBaiduNetdiskConfig: BaiduNetdiskConfig = {
  debugPort: "9337",
  executablePath: "",
};

const defaultBaiduNetdiskDownloadDir = "D:\\BaiduNetdiskDownload";

let store: Store<BaiduNetdiskStore> | null = null;
let downloadRecordsRepository: BaiduNetdiskDownloadRecordsRepository | null = null;
type StableEpisodeFilesListener = NonNullable<
  BaiduNetdiskEnsureDownloadedRequest["onStableEpisodeFiles"]
>;

type ActiveDownloadOperation = {
  promise: Promise<BaiduNetdiskDownloadRecord>;
  stableEpisodeFilesListeners: Set<StableEpisodeFilesListener>;
  localPath: string;
};

const activeDownloadOperations = new Map<string, ActiveDownloadOperation>();
const appVideoTranscodeQueues = new Map<number, VideoTranscodeQueue>();
const monitoredEpisodeVideoRoots = new Set<string>();
const pendingDownloadPaths = new Set<string>();
const diskCleanupUsageThreshold = 0.8;
const stalePlayletAgeMs = 2 * 60 * 60 * 1000;
const diskCleanupIntervalMs = 5 * 60 * 1000;
let diskCleanupTimer: NodeJS.Timeout | null = null;
let diskCleanupOperation: Promise<void> | null = null;
let baiduCdpOperationTail: Promise<void> = Promise.resolve();
let queuedBaiduCdpOperations = 0;

function normalizedPathKey(value: string) {
  return path.resolve(value).toLowerCase();
}

function isSafeEpisodeVideoRootOnDriveD(rootPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const driveRoot = path.parse(resolvedRoot).root;
  return driveRoot.toLowerCase() === "d:\\" && normalizedPathKey(resolvedRoot) !== normalizedPathKey(driveRoot);
}

async function latestTreeModifiedAtMs(targetPath: string): Promise<number> {
  const targetStat = await lstat(targetPath);
  let latest = targetStat.mtimeMs;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return latest;

  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    const entryStat = await lstat(entryPath).catch(() => undefined);
    if (!entryStat) continue;
    latest = Math.max(latest, entryStat.mtimeMs);
    if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
      latest = Math.max(latest, await latestTreeModifiedAtMs(entryPath).catch(() => entryStat.mtimeMs));
    }
  }
  return latest;
}

async function driveDUsageRatio() {
  const stats = await statfs("D:\\", { bigint: true });
  if (stats.blocks <= 0n) return 0;
  return Number(stats.blocks - stats.bfree) / Number(stats.blocks);
}

async function cleanupStalePlayletDirectories(rootPath: string, protectedPaths: Set<string>) {
  if (!isSafeEpisodeVideoRootOnDriveD(rootPath)) {
    baiduNetdiskLogger("storage").warn("Skipped unsafe show directory cleanup", { path: rootPath });
    return;
  }

  const usageRatio = await driveDUsageRatio();
  if (usageRatio < diskCleanupUsageThreshold) return;

  const resolvedRoot = path.resolve(rootPath);
  const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);
  const cutoffMs = Date.now() - stalePlayletAgeMs;
  let deletedCount = 0;

  baiduNetdiskLogger("storage").warn("Low disk space; cleaning stale playlet directories", {
    path: resolvedRoot,
    usedPercent: Number((usageRatio * 100).toFixed(1)),
  });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.resolve(resolvedRoot, entry.name);
    if (path.dirname(candidate).toLowerCase() !== resolvedRoot.toLowerCase()) continue;
    const candidateKey = normalizedPathKey(candidate);
    const activePaths = [...activeDownloadOperations.values()]
      .some((operation) => normalizedPathKey(operation.localPath) === candidateKey);
    if (protectedPaths.has(candidateKey) || pendingDownloadPaths.has(candidateKey) || activePaths) continue;

    const candidateStat = await lstat(candidate).catch(() => undefined);
    if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink()) continue;
    const latestModifiedAtMs = await latestTreeModifiedAtMs(candidate).catch(() => candidateStat.mtimeMs);
    if (latestModifiedAtMs > cutoffMs) continue;

    await rm(candidate, { recursive: true, force: true });
    deletedCount += 1;
    baiduNetdiskLogger("storage").warn("Deleted stale playlet directory", {
      path: candidate,
      lastModifiedAt: new Date(latestModifiedAtMs).toISOString(),
    });
  }

  baiduNetdiskLogger("storage").info("Stale playlet directory cleanup completed", {
    path: resolvedRoot,
    deletedCount,
  });
}

function runDiskCleanup(protectedExtraPaths: string[] = []) {
  if (diskCleanupOperation) return diskCleanupOperation;
  const protectedPaths = new Set([
    ...[...activeDownloadOperations.values()].map((operation) => normalizedPathKey(operation.localPath)),
    ...protectedExtraPaths.map(normalizedPathKey),
  ]);
  diskCleanupOperation = (async () => {
    const usageRatio = await driveDUsageRatio().catch(() => 0);
    if (usageRatio >= diskCleanupUsageThreshold) {
      await runRuntimeAssetCleanup({
        reason: "disk-pressure",
        diskPressure: true,
      });
    }

    for (const rootPath of monitoredEpisodeVideoRoots) {
      await cleanupStalePlayletDirectories(rootPath, protectedPaths).catch((error) => {
        baiduNetdiskLogger("storage").warn("Playlet directory check or cleanup failed", {
          path: rootPath,
          error,
        });
      });
    }
  })().finally(() => {
    diskCleanupOperation = null;
  });
  return diskCleanupOperation;
}

function startDiskCleanupMonitor() {
  if (diskCleanupTimer) return;
  diskCleanupTimer = setInterval(() => {
    void runDiskCleanup();
  }, diskCleanupIntervalMs);
  diskCleanupTimer.unref();
}

function runBaiduCdpOperationExclusive<T>(label: string, operation: () => Promise<T>): Promise<T> {
  queuedBaiduCdpOperations += 1;
  const queuePosition = queuedBaiduCdpOperations;
  if (queuePosition > 1) {
    baiduNetdiskLogger("netdisk").info("Netdisk operation queued", {
      action: label,
      ahead: queuePosition - 1,
    });
  }

  const previous = baiduCdpOperationTail;
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      baiduNetdiskLogger("netdisk").info("Netdisk operation started", { action: label });
      try {
        return await operation();
      } finally {
        queuedBaiduCdpOperations = Math.max(0, queuedBaiduCdpOperations - 1);
        baiduNetdiskLogger("netdisk").info("Netdisk operation finished", { action: label });
      }
    });
  baiduCdpOperationTail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function getStore() {
  if (!store) {
    store = createValidatedStore<BaiduNetdiskStore>({
      name: "baidu-netdisk-config",
      defaults: {
        config: defaultBaiduNetdiskConfig,
      },
    });
  }

  return store;
}

function normalizeDebugPort(value: string | undefined) {
  const port = Number.parseInt(value ?? "", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return defaultBaiduNetdiskConfig.debugPort;
  }

  return String(port);
}

function normalizeConfig(
  config: Partial<BaiduNetdiskConfig> & Record<string, string | undefined>,
): BaiduNetdiskConfig {
  return {
    debugPort: normalizeDebugPort(config.debugPort),
    executablePath: config.executablePath?.trim() ?? "",
  };
}

function readConfig() {
  return normalizeConfig(getStore().get("config"));
}

function writeConfig(config: BaiduNetdiskConfig) {
  getStore().set("config", config);
}

function configPath() {
  return getStore().path;
}

function getDownloadRecordsRepository() {
  if (!downloadRecordsRepository) {
    downloadRecordsRepository = new BaiduNetdiskDownloadRecordsRepository();
  }

  return downloadRecordsRepository;
}

function readDownloadRecords() {
  return getDownloadRecordsRepository().list();
}

function upsertDownloadRecord(record: BaiduNetdiskDownloadRecord): BaiduNetdiskDownloadRecord {
  const nextRecord = getDownloadRecordsRepository().upsert(record);
  broadcastDownloadRecordsChanged();
  return nextRecord;
}

function createRecordId(shareKey: string, resourceName: string) {
  return createHash("sha1")
    .update(`${shareKey}\n${resourceName.trim()}`)
    .digest("hex")
    .slice(0, 16);
}

function trimShareLink(value: string) {
  return value.replace(/[),，。；;、\]]+$/g, "");
}

function sanitizeWindowsName(value: string) {
  const sanitized = value.replace(/[\\/:*?"<>|]/g, "_").trim();
  return sanitized || "百度网盘分享";
}

function shareKeyFromText(shareText: string) {
  const link = trimShareLink(
    shareText.match(/https?:\/\/pan\.baidu\.com\/s\/[^\s"'<>]+/)?.[0] ?? "",
  );

  if (!link) {
    throw new Error("分享文本中没有找到百度网盘链接。");
  }

  try {
    const url = new URL(link);
    const pwd =
      url.searchParams.get("pwd") ??
      shareText.match(/(?:提取码|密码|pwd)[:：\s]*([a-zA-Z0-9]{4})/)?.[1];
    if (!pwd) {
      throw new Error("分享文本中没有找到提取码。");
    }

    return [url.origin.toLowerCase(), url.pathname.replace(/\/+$/, ""), pwd.toLowerCase()]
      .join("|");
  } catch (error) {
    if (error instanceof Error && error.message.includes("提取码")) {
      throw error;
    }
    throw Object.assign(new Error("分享文本中的百度网盘链接格式不正确。"), { cause: error });
  }
}

function uniqueBaiduDownloadDir(resourceName: string, shareKey: string) {
  const safeName = Array.from(
    resourceName,
    (character) => character.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(character)
      ? "_"
      : character,
  )
    .join("")
    .trim() || "资源";
  const suffix = createHash("sha1").update(shareKey).digest("hex").slice(0, 10);
  return path.join(defaultBaiduNetdiskDownloadDir, `${safeName}__${suffix}`);
}

function assertDisposableBaiduDownloadDir(downloadDir: string) {
  const root = path.resolve(defaultBaiduNetdiskDownloadDir);
  const target = path.resolve(downloadDir);
  const relative = path.relative(root, target);

  if (
    !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || !/__[\da-f]{10}$/i.test(path.basename(target))
  ) {
    throw new Error(`拒绝清理非独立百度下载目录：${target}`);
  }
}

async function cleanupBaiduNetdiskDownloadArtifacts(options: {
  downloadDir: string;
  targetName: string;
  port: number;
}) {
  try {
    assertDisposableBaiduDownloadDir(options.downloadDir);
  } catch (error) {
    baiduNetdiskLogger("storage").warn("Skipped unsafe temporary directory cleanup", { error });
    return;
  }

  const { controlBaiduNetdiskDownloadTask } = await importBaiduNetdiskDownloadRuntimePackage();
  const downloadTaskNames = [
    options.targetName,
    "视频",
    "成片",
    "成品",
    "正片",
    "权属",
    "工程",
    "封面",
    "海报",
    "AI制作证明",
  ];
  let cleanupAttemptCount = 0;
  for (const targetName of downloadTaskNames) {
    try {
      await runBaiduCdpOperationExclusive(`清理百度下载任务：${targetName}`, () =>
        controlBaiduNetdiskDownloadTask({
          port: options.port,
          targetName,
          action: "delete",
          expectedDownloadRoot: options.downloadDir,
        }),
      );
      cleanupAttemptCount += 1;
    } catch {
      // A material category may not have created its own native download task.
    }
  }
  baiduNetdiskLogger("download").info("Baidu download task cleanup completed", {
    resourceName: options.targetName,
    cleanupAttemptCount,
  });

  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        rm(options.downloadDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 500,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("清理临时下载目录等待超过 30 秒")),
            30_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    baiduNetdiskLogger("storage").info("Temporary download directory cleaned", { path: options.downloadDir });
  } catch (error) {
    baiduNetdiskLogger("storage").warn("Temporary download directory cleanup failed", {
      path: options.downloadDir,
      error,
    });
  }
}

async function cleanupRecordedRemoteTransfer(
  record: BaiduNetdiskDownloadRecord,
  port: number,
  reason: string,
) {
  if (
    !record.remoteCleanupPending
    || !record.remoteTransferOwned
    || !record.remoteTransferPath
    || !record.remoteTransferFsId
  ) {
    return record;
  }

  const cleanupLogger = baiduNetdiskLogger("storage", {
    resourceName: record.resourceName,
    remoteTransferPath: record.remoteTransferPath,
  });
  try {
    const runtime = await importBaiduNetdiskDownloadRuntimePackage();
    await runBaiduCdpOperationExclusive(`清理网盘中转目录：${record.resourceName}`, () =>
      runtime.deleteBaiduNetdiskTemporaryTransfer({
        port,
        shareText: record.shareText,
        path: record.remoteTransferPath!,
        fsId: record.remoteTransferFsId!,
      }),
    );
    cleanupLogger.info("Remote transfer directory cleanup completed", { reason });
    return upsertDownloadRecord({
      ...record,
      remoteCleanupPending: false,
      remoteCleanupError: undefined,
    });
  } catch (error) {
    const cleanupError = readableError(error);
    cleanupLogger.warn("Remote transfer directory cleanup failed; retained as pending cleanup task", {
      reason,
      error: cleanupError,
    });
    return upsertDownloadRecord({
      ...record,
      remoteCleanupPending: true,
      remoteCleanupError: cleanupError,
    });
  }
}

let remoteCleanupRecovery: Promise<void> | null = null;

function recoverPendingRemoteTransferCleanups() {
  if (remoteCleanupRecovery) return remoteCleanupRecovery;
  const pendingRecords = getDownloadRecordsRepository()
    .list(1000)
    .filter((record) => record.remoteCleanupPending && record.remoteTransferOwned);
  if (pendingRecords.length === 0) return Promise.resolve();

  remoteCleanupRecovery = (async () => {
    const port = cdpPort(readConfig());
    await startCdp(false);
    for (const pendingRecord of pendingRecords) {
      if (activeDownloadOperations.has(pendingRecord.id)) continue;
      await cleanupBaiduNetdiskDownloadArtifacts({
        downloadDir: pendingRecord.downloadDir,
        targetName: pendingRecord.resourceName,
        port,
      });
      const recovered = await cleanupRecordedRemoteTransfer(
        pendingRecord,
        port,
        "应用启动恢复",
      );
      if (pendingRecord.state === "downloading") {
        upsertDownloadRecord({
          ...recovered,
          state: "failed",
          error: recovered.remoteCleanupPending
            ? "上次运行异常中断；网盘中转目录仍待清理。"
            : "上次运行异常中断；网盘中转目录已清理。",
        });
      }
    }
  })()
    .catch((error) => {
      baiduNetdiskLogger("storage").warn("Failed to recover remote transfer directory cleanup on startup", { error });
    })
    .finally(() => {
      remoteCleanupRecovery = null;
    });
  return remoteCleanupRecovery;
}

function normalizeEnsureDownloadRequest(
  request: BaiduNetdiskEnsureDownloadedRequest,
): BaiduNetdiskEnsureDownloadedRequest {
  const shareText = request.shareText.trim();
  const resourceName = sanitizeWindowsName(request.resourceName);
  const localEpisodeVideoRoot = request.localEpisodeVideoRoot.trim();
  const episodeCount = Number(request.episodeCount);
  const episodeDownloadLimit = request.episodeDownloadLimit === undefined
    ? undefined
    : Number(request.episodeDownloadLimit);
  const inferEpisodeCount = request.inferEpisodeCount === true;
  const downloadEpisodeVideos = request.downloadEpisodeVideos !== false;

  if (!shareText) {
    throw new Error("百度网盘分享链接不能为空。");
  }
  if (!resourceName) {
    throw new Error("百度网盘资源名称不能为空。");
  }
  if (!localEpisodeVideoRoot) {
    throw new Error("本地剧集视频根目录不能为空。");
  }
  if (
    (!Number.isInteger(episodeCount)
      || (downloadEpisodeVideos ? episodeCount <= 0 : episodeCount < 0))
    && !(downloadEpisodeVideos && inferEpisodeCount)
  ) {
    throw new Error("剧集数量必须是正整数，或启用自动识别集数。");
  }
  if (
    episodeDownloadLimit !== undefined
    && (!Number.isInteger(episodeDownloadLimit) || episodeDownloadLimit <= 0)
  ) {
    throw new Error("仅下载前 X 集的集数必须是正整数。");
  }

  return {
    shareText,
    resourceName,
    localEpisodeVideoRoot,
    episodeCount: Number.isInteger(episodeCount) && episodeCount >= 0
      ? episodeCount
      : undefined,
    episodeDownloadLimit,
    inferEpisodeCount,
    downloadEpisodeVideos,
    downloadAssetMaterials: request.downloadAssetMaterials,
    forceAssetDownload: request.forceAssetDownload,
    requireAllDiscoveredAssets: request.requireAllDiscoveredAssets,
    requiredOwnership: request.requiredOwnership,
    requiredOwnershipFiles: request.requiredOwnershipFiles,
    requiredPosterImages: request.requiredPosterImages,
    posterFallback: request.posterFallback
      ? {
          title: request.posterFallback.title?.trim() || resourceName,
          summary: request.posterFallback.summary?.trim() ?? "",
        }
      : undefined,
    requiredAiProductionProofFiles: request.requiredAiProductionProofFiles,
    requiredMetadataTextFiles: request.requiredMetadataTextFiles,
    mergeOwnershipMaterials: request.mergeOwnershipMaterials,
    requesterPlatform: request.requesterPlatform,
    videoTranscode: request.videoTranscode,
    signal: request.signal,
    onStableEpisodeFiles: request.onStableEpisodeFiles,
  };
}

function appVideoTranscodeQueue(concurrency: number) {
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency) || 2);
  let queue = appVideoTranscodeQueues.get(normalizedConcurrency);
  if (!queue) {
    queue = new VideoTranscodeQueue({
      concurrency: normalizedConcurrency,
      onLog: baiduNetdiskLogger("download").callback("download"),
    });
    appVideoTranscodeQueues.set(normalizedConcurrency, queue);
  }
  return queue;
}

function withAppVideoTranscode(
  request: BaiduNetdiskEnsureDownloadedRequest,
): BaiduNetdiskEnsureDownloadedRequest {
  const settings = request.videoTranscode;
  if (!settings) return request;

  const maxFileBytes = Math.max(1, settings.maxFileMegabytes) * 1_000_000;
  const targetFileBytes = Math.max(1, settings.targetFileMegabytes) * 1_000_000;
  if (targetFileBytes >= maxFileBytes) {
    throw new Error("百度应用测试转码目标体积必须小于触发体积。");
  }
  const queue = appVideoTranscodeQueue(settings.concurrency);
  const cacheRootDir = path.join(
    resolveFromAppRoot(settings.runDataDir),
    "media-cache",
    "video-transcodes",
  );
  return {
    ...request,
    onStableEpisodeFiles: (files) => {
      for (const file of files) {
        if (file.size <= maxFileBytes) continue;
        baiduNetdiskLogger("download").info("Video exceeded size limit and was added to transcode queue", {
          episode: file.index,
          size: file.size,
          maxFileBytes,
        });
        void queue.add({
          inputFile: file.file,
          cacheRootDir,
          policy: {
            maxFileBytes,
            targetFileBytes,
            audioBitrateKbps: 128,
            threadsPerJob: Math.max(1, Math.floor(settings.threadsPerJob) || 2),
          },
          replaceSource: true,
        }).catch((error) => {
          baiduNetdiskLogger("download").error("Video transcoding failed during download", {
            episode: file.index,
            error,
          });
        });
      }
    },
  };
}

function playletDir(root: string, resourceName: string) {
  return path.join(root, resourceName);
}

function cdpPort(config = readConfig()) {
  return Number.parseInt(config.debugPort, 10);
}

async function importBaiduNetdiskRuntimePackage() {
  const runtime = await import("@dramabridge/baidu-netdisk-automation") as {
    configureBaiduNetdiskAutomationLogging: (options: {
      logFilePath: string;
      retentionDays?: number;
    }) => void;
    checkBaiduNetdiskCdpStatus: (options: {
      port: number;
      executablePath?: string;
    }) => Promise<BaiduNetdiskCdpStatus>;
    startBaiduNetdiskCdp: (options: {
      port: number;
      executablePath?: string;
      restart?: boolean;
    }) => Promise<BaiduNetdiskLaunchResult>;
  };
  runtime.configureBaiduNetdiskAutomationLogging({
    logFilePath: baiduNetdiskLogFilePath(),
    retentionDays: 3,
  });
  return runtime;
}

async function importBaiduNetdiskDownloadRuntimePackage() {
  const runtime = await import("@dramabridge/baidu-netdisk-automation/download-baidu-folder") as {
    configureBaiduNetdiskAutomationLogging: (options: {
      logFilePath: string;
      retentionDays?: number;
    }) => void;
    downloadBaiduNetdiskShare: (options: {
      shareText: string;
      resourceName?: string;
      expectedEpisodeCount?: number;
      episodeDownloadLimit?: number;
      inferEpisodeCount?: boolean;
      expectedOwnershipCounts?: {
        minimumImages?: number;
        minimumJianyingImages?: number;
      };
      expectedOwnershipFiles?: number;
      expectedPosterImages?: number;
      expectedAiProductionProofFiles?: number;
      expectedMetadataTextFiles?: number;
      downloadEpisodeVideos?: boolean;
      downloadAssetMaterials?: boolean;
      requireAllDiscoveredAssets?: boolean;
      port: number;
      downloadDir: string;
      signal?: AbortSignal;
      onTemporaryTransferCreated?: (transfer: {
        path: string;
        fsId: number | string;
        createdByAutomation: true;
      }) => void | Promise<void>;
      selectEpisodeFiles?: (request: {
        resourceName: string;
        expectedEpisodeCount?: number;
        candidates: Array<{
          id: number;
          index?: number;
          name: string;
          path: string;
          size?: number;
        }>;
      }) => Promise<Array<{ path: string; index: number }>>;
    }) => Promise<Omit<BaiduNetdiskShareDownloadResult, "downloadDir">>;
    getBaiduNetdiskDownloadTaskStatus: (options: { port: number; targetName: string }) => Promise<{
      found: boolean;
      name?: string;
      localPath?: string;
      status?: string;
      size?: number;
      finishSize?: number;
      rate?: string;
      completed: boolean;
      tasks: string[];
    }>;
    controlBaiduNetdiskDownloadTask: (options: {
      port: number;
      targetName: string;
      action: "pause" | "resume" | "delete";
      expectedDownloadRoot?: string;
    }) => Promise<boolean>;
    deleteBaiduNetdiskTemporaryTransfer: (options: {
      port?: number;
      shareText: string;
      path: string;
      fsId: number | string;
    }) => Promise<void>;
    deleteBaiduNetdiskPlayletDirectory: (options: {
      port?: number;
      shareText: string;
      path: string;
      fsId: number | string;
    }) => Promise<void>;
  };
  runtime.configureBaiduNetdiskAutomationLogging({
    logFilePath: baiduNetdiskLogFilePath(),
    retentionDays: 3,
  });
  return runtime;
}

async function status() {
  const config = readConfig();
  const { checkBaiduNetdiskCdpStatus } = await importBaiduNetdiskRuntimePackage();

  return checkBaiduNetdiskCdpStatus({
    port: cdpPort(config),
    executablePath: config.executablePath || undefined,
  });
}

async function controlDownloadTask(targetName: string, action: "pause" | "resume" | "delete") {
  const config = readConfig();
  const runtime = await importBaiduNetdiskDownloadRuntimePackage();
  const result = await runtime.controlBaiduNetdiskDownloadTask({ port: cdpPort(config), targetName, action });
  if (action === "delete") clearDownloadRecords();
  return result;
}

async function startCdp(restart: boolean) {
  const config = readConfig();
  const { startBaiduNetdiskCdp } = await importBaiduNetdiskRuntimePackage();

  return startBaiduNetdiskCdp({
    port: cdpPort(config),
    executablePath: config.executablePath || undefined,
    restart,
  });
}

export async function ensureBaiduNetdiskCdpReadyOnStartup() {
  const currentStatus = await status();

  if (currentStatus.ready) {
    return {
      action: "none" as const,
      status: currentStatus,
    };
  }

  if (!currentStatus.isWindows) {
    return {
      action: "unsupported" as const,
      status: currentStatus,
    };
  }

  const launchResult = await startCdp(currentStatus.appRunning);

  return {
    action: currentStatus.appRunning ? ("restart" as const) : ("start" as const),
    status: launchResult.status,
    launchResult,
  };
}

function normalizeShareText(request: BaiduNetdiskShareDownloadRequest | undefined) {
  const shareText = request?.shareText?.trim();

  if (!shareText) {
    throw new Error("请先粘贴包含百度网盘链接和提取码的分享文本。");
  }

  return shareText;
}

async function downloadShare(request?: BaiduNetdiskShareDownloadRequest) {
  const shareText = normalizeShareText(request);
  const config = readConfig();
  const { downloadBaiduNetdiskShare } = await importBaiduNetdiskDownloadRuntimePackage();
  const shareKey = shareKeyFromText(shareText);
  const recordId = createRecordId(shareKey, shareKey);
  const now = new Date().toISOString();
  const record = upsertDownloadRecord({
    id: recordId,
    shareKey,
    shareText,
    resourceName: "百度网盘分享",
    downloadDir: defaultBaiduNetdiskDownloadDir,
    state: "pending",
    skippedExisting: false,
    createdAt: readDownloadRecords().find((item) => item.id === recordId)?.createdAt ?? now,
    updatedAt: now,
    startedAt: now,
  });

  let result: Omit<BaiduNetdiskShareDownloadResult, "downloadDir">;

  try {
    result = await runBaiduCdpOperationExclusive("手动下载百度网盘分享", () =>
      downloadBaiduNetdiskShare({
        shareText,
        port: cdpPort(config),
        downloadDir: defaultBaiduNetdiskDownloadDir,
        selectEpisodeFiles: (selectionRequest) => selectBaiduEpisodePathsWithAi({
          client: createConfiguredAiClient(),
          ...selectionRequest,
        }),
      }),
    );
  } catch (error) {
    const message = readableError(error);
    upsertDownloadRecord({
      ...record,
      state: "failed",
      error: message,
    });
    throw Object.assign(new Error(message), { cause: error });
  }

  const state: BaiduNetdiskDownloadState =
    result.completed || result.skippedExisting ? "completed" : "downloading";
  upsertDownloadRecord({
    ...record,
    resourceName: result.share.name,
    downloadDir: defaultBaiduNetdiskDownloadDir,
    localPath: result.localPath,
    state,
    skippedExisting: result.skippedExisting,
    error: undefined,
    completedAt: state === "completed" ? new Date().toISOString() : undefined,
  });

  return {
    ...result,
    downloadDir: defaultBaiduNetdiskDownloadDir,
  } satisfies BaiduNetdiskShareDownloadResult;
}

export async function ensureBaiduNetdiskShareDownloaded(
  request: BaiduNetdiskEnsureDownloadedRequest,
): Promise<BaiduNetdiskDownloadRecord> {
  await recoverPendingRemoteTransferCleanups();
  const normalizedRequest = normalizeEnsureDownloadRequest(request);
  const requestLogger = baiduNetdiskLogger("netdisk", {
    requesterPlatform: normalizedRequest.requesterPlatform,
    resourceName: normalizedRequest.resourceName,
  });
  const shareKey = shareKeyFromText(normalizedRequest.shareText);
  const id = createRecordId(
    shareKey,
    normalizedRequest.episodeDownloadLimit
      ? `${normalizedRequest.resourceName}\nlimit=${normalizedRequest.episodeDownloadLimit}`
      : normalizedRequest.resourceName,
  );
  const localPath = playletDir(
    normalizedRequest.localEpisodeVideoRoot,
    normalizedRequest.resourceName,
  );
  monitoredEpisodeVideoRoots.add(path.resolve(normalizedRequest.localEpisodeVideoRoot));
  startDiskCleanupMonitor();
  const activeOperation = activeDownloadOperations.get(id);

  if (activeOperation) {
    if (normalizedRequest.onStableEpisodeFiles) {
      activeOperation.stableEpisodeFilesListeners.add(normalizedRequest.onStableEpisodeFiles);
      requestLogger.info("Material processor attached to ongoing download task");
    }
    return activeOperation.promise;
  }

  const localPathKey = normalizedPathKey(localPath);
  pendingDownloadPaths.add(localPathKey);
  try {
    await runDiskCleanup([localPath]);
  } finally {
    pendingDownloadPaths.delete(localPathKey);
  }

  const stableEpisodeFilesListeners = new Set<StableEpisodeFilesListener>();
  if (normalizedRequest.onStableEpisodeFiles) {
    stableEpisodeFilesListeners.add(normalizedRequest.onStableEpisodeFiles);
  }
  const requestWithListenerBroadcast: BaiduNetdiskEnsureDownloadedRequest = {
    ...normalizedRequest,
    onStableEpisodeFiles: (files) => {
      if (stableEpisodeFilesListeners.size > 0) {
        requestLogger.info("Material processor notified", {
          episodes: files.map((file) => file.index),
        });
      }
      for (const listener of stableEpisodeFilesListeners) {
        try {
          listener(files);
        } catch (error) {
          requestLogger.warn("Material processor failed to receive stable episode files", { error });
        }
      }
    },
  };
  const promise = ensureBaiduNetdiskShareDownloadedOnce(
    id,
    shareKey,
    requestWithListenerBroadcast,
  ).finally(() => {
    activeDownloadOperations.delete(id);
  });
  activeDownloadOperations.set(id, { promise, stableEpisodeFilesListeners, localPath });

  return promise;
}

async function ensureBaiduNetdiskShareDownloadedOnce(
  id: string,
  shareKey: string,
  request: BaiduNetdiskEnsureDownloadedRequest,
): Promise<BaiduNetdiskDownloadRecord> {
  const uniqueDownloadDir = uniqueBaiduDownloadDir(request.resourceName, shareKey);
  const config = readConfig();
  const timeoutMs = getConfiguredBaiduNetdiskDownloadTimeoutMs();
  const port = cdpPort(config);
  const existingRecord = readDownloadRecords().find((record) => record.id === id);
  if (existingRecord?.remoteCleanupPending) {
    throw new Error(
      `上一次任务的网盘中转目录仍待清理：${existingRecord.remoteTransferPath || "未知路径"}。` +
        "系统已停止创建新的中转目录，请确认百度网盘在线后重试。",
    );
  }
  const localPath = playletDir(request.localEpisodeVideoRoot, request.resourceName);
  const now = new Date().toISOString();
  let record = upsertDownloadRecord({
    id,
    shareKey,
    shareText: request.shareText,
    resourceName: request.resourceName,
    localEpisodeVideoRoot: request.localEpisodeVideoRoot,
    episodeCount: request.episodeCount,
    downloadDir: uniqueDownloadDir,
    localPath,
    state: existingRecord?.state ?? "pending",
    skippedExisting: existingRecord?.skippedExisting ?? false,
    error: undefined,
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now,
    startedAt: existingRecord?.startedAt,
    completedAt: existingRecord?.completedAt,
    remoteTransferPath: existingRecord?.remoteTransferPath,
    remoteTransferFsId: existingRecord?.remoteTransferFsId,
    remoteTransferOwned: existingRecord?.remoteTransferOwned,
    remoteCleanupPending: existingRecord?.remoteCleanupPending,
    remoteCleanupError: existingRecord?.remoteCleanupError,
    remoteResourcePath: existingRecord?.remoteResourcePath,
    remoteResourceFsId: existingRecord?.remoteResourceFsId,
    remoteResourceCleanupCompletedAt: existingRecord?.remoteResourceCleanupCompletedAt,
    remoteResourceCleanupError: existingRecord?.remoteResourceCleanupError,
  });

  record = upsertDownloadRecord({
    ...record,
    state: "downloading",
    skippedExisting: false,
    error: undefined,
    startedAt: record.startedAt ?? new Date().toISOString(),
    completedAt: undefined,
  });
  let downloadArtifactsCleaned = false;

  try {
    const {
      downloadBaiduNetdiskShare,
      getBaiduNetdiskDownloadTaskStatus,
      controlBaiduNetdiskDownloadTask,
    } = await importBaiduNetdiskDownloadRuntimePackage();
    const runDownload = () => ensureBaiduNetdiskEpisodeVideos({
      shareText: request.shareText,
      resourceName: request.resourceName,
      localEpisodeVideoRoot: request.localEpisodeVideoRoot,
      episodeCount: request.episodeCount,
      episodeDownloadLimit: request.episodeDownloadLimit,
      downloadEpisodeVideos: request.downloadEpisodeVideos,
      downloadAssetMaterials: request.downloadAssetMaterials,
      inferEpisodeCount: request.inferEpisodeCount,
      forceAssetDownload: request.forceAssetDownload,
      requireAllDiscoveredAssets: request.requireAllDiscoveredAssets,
      requiredOwnership: request.requiredOwnership,
      requiredOwnershipFiles: request.requiredOwnershipFiles,
      requiredPosterImages: request.requiredPosterImages,
      requiredAiProductionProofFiles: request.requiredAiProductionProofFiles,
      requiredMetadataTextFiles: request.requiredMetadataTextFiles,
      mergeOwnershipMaterials: request.mergeOwnershipMaterials,
      timeoutMs,
      downloadDir: uniqueDownloadDir,
      sourceLocalPath: existingRecord?.localPath,
      downloadTaskName: existingRecord?.resourceName,
      downloadShare: async (downloadRequest) => {
        const downloadResult = await runBaiduCdpOperationExclusive(downloadRequest.resourceName, () =>
          downloadBaiduNetdiskShare({
            shareText: downloadRequest.shareText,
            resourceName: downloadRequest.resourceName,
            expectedEpisodeCount: downloadRequest.expectedEpisodeCount,
            episodeDownloadLimit: downloadRequest.episodeDownloadLimit,
            inferEpisodeCount: downloadRequest.inferEpisodeCount,
            expectedOwnershipCounts: downloadRequest.expectedOwnershipCounts,
            expectedOwnershipFiles: downloadRequest.expectedOwnershipFiles,
            expectedPosterImages: downloadRequest.expectedPosterImages,
            expectedAiProductionProofFiles: downloadRequest.expectedAiProductionProofFiles,
            expectedMetadataTextFiles: downloadRequest.expectedMetadataTextFiles,
            downloadEpisodeVideos: downloadRequest.downloadEpisodeVideos,
            downloadAssetMaterials: downloadRequest.downloadAssetMaterials,
            requireAllDiscoveredAssets: downloadRequest.requireAllDiscoveredAssets,
            port,
            downloadDir: downloadRequest.downloadDir,
            signal: request.signal,
            selectEpisodeFiles: (selectionRequest) => selectBaiduEpisodePathsWithAi({
              client: createConfiguredAiClient(),
              ...selectionRequest,
            }),
            onTemporaryTransferCreated: (transfer) => {
              record = upsertDownloadRecord({
                ...record,
                remoteTransferPath: transfer.path,
                remoteTransferFsId: String(transfer.fsId),
                remoteTransferOwned: transfer.createdByAutomation,
                remoteCleanupPending: transfer.createdByAutomation,
                remoteCleanupError: undefined,
              });
              baiduNetdiskLogger("storage", {
                requesterPlatform: request.requesterPlatform,
                resourceName: request.resourceName,
              }).info("Recorded remote transfer directory created by software", {
                path: transfer.path,
              });
            },
          }),
        );
        if (downloadResult.remoteResourceRoot) {
          record = upsertDownloadRecord({
            ...record,
            remoteResourcePath: downloadResult.remoteResourceRoot.path,
            remoteResourceFsId: String(downloadResult.remoteResourceRoot.fsId),
            remoteResourceCleanupCompletedAt: undefined,
            remoteResourceCleanupError: undefined,
          });
        }
        return downloadResult;
      },
      getDownloadTaskStatus: (statusRequest) =>
        getBaiduNetdiskDownloadTaskStatus({
          port,
          targetName: statusRequest.targetName,
        }),
      cancelDownloadTask: (cancelRequest) =>
        controlBaiduNetdiskDownloadTask({
          port,
          targetName: cancelRequest.targetName,
          action: "delete",
          expectedDownloadRoot: cancelRequest.downloadRoot,
        }).then(() => undefined),
      signal: request.signal,
      onStableEpisodeFiles: request.onStableEpisodeFiles,
      onLog: baiduNetdiskLogger("download", {
        requesterPlatform: request.requesterPlatform,
        resourceName: request.resourceName,
      }).callback("download"),
      onProgress: (progress) => {
        record = upsertDownloadRecord({
          ...record,
          downloadDir: progress.downloadRoot ?? record.downloadDir,
          localPath: progress.localPath ?? record.localPath,
          nativeStatus: progress.nativeStatus ?? record.nativeStatus,
          progressPercent: progress.progressPercent ?? record.progressPercent,
          transferredBytes: progress.transferredBytes ?? record.transferredBytes,
          totalBytes: progress.totalBytes ?? record.totalBytes,
          speedText: progress.speedText ?? record.speedText,
          skippedExisting: progress.skippedExisting ?? record.skippedExisting,
          state: progress.phase === "existing-complete" || progress.phase === "standardized"
            ? "completed"
            : "downloading",
          error: undefined,
        });
      },
    });
    let result;
    try {
      result = await runDownload();
    } catch (error) {
      const fallbackEnabled = isAiPosterFallbackEnabled();
      const missingPoster = request.requiredPosterImages
        && request.requiredPosterImages > 0
        && isRemoteMaterialValidationError(error, "poster");
      if (!fallbackEnabled || !missingPoster) throw error;

      const summary = request.posterFallback?.summary.trim();
      if (!summary) {
        throw Object.assign(
          new Error(`百度网盘未提供海报，AI 兜底生成需要任务返回剧目简介。原始错误：${readableError(error)}`),
          { cause: error },
        );
      }

      record = await cleanupRecordedRemoteTransfer(
        record,
        port,
        "AI 海报兜底重试前",
      );
      if (record.remoteCleanupPending) {
        throw Object.assign(
          new Error("旧网盘中转目录尚未清理，已停止创建新的中转目录；下次启动将自动重试清理。"),
          { cause: error },
        );
      }

      const aiPosterLogger = baiduNetdiskLogger("ai-poster", {
        requesterPlatform: request.requesterPlatform,
        resourceName: request.resourceName,
      });
      aiPosterLogger.warn("Baidu Netdisk did not provide a poster; starting AI generation", {
        summaryLength: summary.length,
      });
      try {
        const poster = await ensureAiPoster({
          client: createConfiguredAiClient(),
          model: getConfiguredAiImageModel(),
          retryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
          localMaterialRoot: request.localEpisodeVideoRoot,
          resourceName: request.resourceName,
          title: request.posterFallback?.title || request.resourceName,
          summary,
          onLog: aiPosterLogger.callback("ai-poster"),
        });
        aiPosterLogger.info("AI poster ready; revalidating Baidu Netdisk resources", {
          file: poster.file,
          height: poster.height,
          reused: poster.reused,
          size: poster.size,
          width: poster.width,
        });
      } catch (generationError) {
        throw Object.assign(
          new Error(`百度网盘未提供海报，AI 兜底生成失败：${readableError(generationError)}`),
          { cause: generationError },
        );
      }
      result = await runDownload();
    }

    record = await cleanupRecordedRemoteTransfer(record, port, "本地下载及校验完成");
    const completedLocalPath = result.localPath || localPath;
    const completedAt = new Date();
    await utimes(completedLocalPath, completedAt, completedAt).catch((error) => {
      baiduNetdiskLogger("storage").warn("Unable to refresh playlet directory retention time", {
        path: completedLocalPath,
        error,
      });
    });

    return upsertDownloadRecord({
      ...record,
      resourceName: request.resourceName,
      episodeCount: result.episodeCount,
      localPath: completedLocalPath,
      progressPercent: 100,
      state: "completed",
      skippedExisting: result.skippedExisting,
      error: undefined,
      completedAt: completedAt.toISOString(),
    });
  } catch (error) {
    const message = readableError(error);
    if (record.remoteCleanupPending) {
      await cleanupBaiduNetdiskDownloadArtifacts({
        downloadDir: uniqueDownloadDir,
        targetName: request.resourceName,
        port,
      });
      downloadArtifactsCleaned = true;
      record = await cleanupRecordedRemoteTransfer(
        record,
        port,
        request.signal?.aborted ? "用户终止任务" : "任务失败",
      );
    }
    upsertDownloadRecord({
      ...record,
      state: "failed",
      error: message,
    });
    throw Object.assign(new Error(message), { cause: error });
  } finally {
    if (!downloadArtifactsCleaned) {
      // The caller may retry as soon as this operation settles. Cleanup must
      // finish first, otherwise an old attempt can delete the native download
      // task created by the next attempt for the same resource.
      await cleanupBaiduNetdiskDownloadArtifacts({
        downloadDir: uniqueDownloadDir,
        targetName: request.resourceName,
        port,
      }).catch((error) => {
        baiduNetdiskLogger("storage", {
          requesterPlatform: request.requesterPlatform,
          resourceName: request.resourceName,
        }).warn("Failed to cleanup downloaded temporary resources", { error });
      });
    }
  }
}

export async function cleanupBaiduNetdiskPlayletAfterTaskSuccess(
  resource: unknown,
): Promise<void> {
  if (!isBaiduNetdiskPlayletCleanupEnabled()) return;
  if (!resource || typeof resource !== "object") return;
  const candidate = resource as { id?: unknown; shareText?: unknown; resourceName?: unknown };
  const id = typeof candidate.id === "string"
    || typeof candidate.id === "number"
    || typeof candidate.id === "bigint"
    ? String(candidate.id)
    : typeof candidate.shareText === "string" && typeof candidate.resourceName === "string"
      ? createRecordId(shareKeyFromText(candidate.shareText), candidate.resourceName)
      : "";
  if (!id) return;
  const record = getDownloadRecordsRepository().findById(id);
  if (
    !record
    || record.state !== "completed"
    || !record.remoteResourcePath
    || !record.remoteResourceFsId
    || record.remoteResourceCleanupCompletedAt
  ) {
    return;
  }

  const cleanupLogger = baiduNetdiskLogger("storage", {
    resourceName: record.resourceName,
    remoteResourcePath: record.remoteResourcePath,
  });
  try {
    const config = readConfig();
    await startCdp(false);
    const runtime = await importBaiduNetdiskDownloadRuntimePackage();
    await runBaiduCdpOperationExclusive(`清理网盘剧目目录：${record.resourceName}`, () =>
      runtime.deleteBaiduNetdiskPlayletDirectory({
        port: cdpPort(config),
        shareText: record.shareText,
        path: record.remoteResourcePath!,
        fsId: record.remoteResourceFsId!,
      }),
    );
    upsertDownloadRecord({
      ...record,
      remoteResourceCleanupCompletedAt: new Date().toISOString(),
      remoteResourceCleanupError: undefined,
    });
    cleanupLogger.info("Remote playlet directory cleanup completed after task success");
  } catch (error) {
    const cleanupError = readableError(error);
    upsertDownloadRecord({
      ...record,
      remoteResourceCleanupError: cleanupError,
    });
    cleanupLogger.warn("Remote playlet directory cleanup failed after task success", {
      error: cleanupError,
    });
    throw Object.assign(
      new Error(`任务已成功，但自动清理百度网盘剧目目录失败：${cleanupError}`),
      { cause: error },
    );
  }
}

function isRemoteMaterialValidationError(
  error: unknown,
  material: "episode" | "ownership-images" | "ownership-files" | "poster" | "ai-production-proof",
) {
  return Boolean(
    error
    && typeof error === "object"
    && "_tag" in error
    && error._tag === "RemoteMaterialValidationError"
    && "material" in error
    && error.material === material,
  );
}

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.replace(/^(Error:\s*)+/g, "");
  const transferJsonMatch = normalizedMessage.match(/保存分享到网盘失败：(\{.*\})/);
  const ownListJsonMatch = normalizedMessage.match(/读取我的网盘目录失败：([^；]+)；(?:.*?；)?(\{.*\})/);

  if (transferJsonMatch) {
    try {
      const data = JSON.parse(transferJsonMatch[1]) as {
        errno?: number;
        errmsg?: string;
        show_msg?: string;
        message?: string;
        request_id?: string | number;
      };
      const apiMessage = data.show_msg || data.errmsg || data.message || "";

      if (
        data.errno === -6 ||
        apiMessage.includes("账户已过期") ||
        apiMessage.includes("重新登陆")
      ) {
        return "百度网盘账号登录已过期，请在百度网盘客户端重新登录后再下载。";
      }

      return `保存分享到网盘失败：${apiMessage || "百度接口返回异常"}；errno=${data.errno ?? "-"}${
        data.request_id ? `；request_id=${data.request_id}` : ""
      }`;
    } catch {
      return normalizedMessage;
    }
  }

  if (ownListJsonMatch) {
    try {
      const dir = ownListJsonMatch[1];
      const data = JSON.parse(ownListJsonMatch[2]) as {
        errno?: number;
        errmsg?: string;
        show_msg?: string;
        message?: string;
        request_id?: string | number;
      };
      const apiMessage = data.show_msg || data.errmsg || data.message || "";
      if (data.errno === -6 || apiMessage.includes("账户已过期") || apiMessage.includes("重新登陆")) {
        return "百度网盘账号登录已过期，请在百度网盘客户端重新登录后再下载。";
      }
      if (data.errno === 1 || data.errno === 4) {
        return `读取我的网盘目录失败：${dir}；百度接口临时异常或登录态不可用，请确认客户端已登录并重启为 CDP 模式后重试；errno=${data.errno}${
          data.request_id ? `；request_id=${data.request_id}` : ""
        }`;
      }
      return `读取我的网盘目录失败：${dir}；${apiMessage || "百度接口返回异常"}；errno=${data.errno ?? "-"}${
        data.request_id ? `；request_id=${data.request_id}` : ""
      }`;
    } catch {
      return normalizedMessage;
    }
  }

  if (normalizedMessage.includes("账户已过期") || normalizedMessage.includes("重新登陆")) {
    return "百度网盘账号登录已过期，请在百度网盘客户端重新登录后再下载。";
  }

  return normalizedMessage;
}

function downloadRecordsResult(): BaiduNetdiskDownloadRecordResult {
  const repository = getDownloadRecordsRepository();
  return {
    path: repository.databasePath,
    records: repository.list(),
  };
}

function clearDownloadRecords(): BaiduNetdiskDownloadRecordResult {
  getDownloadRecordsRepository().clear();
  broadcastDownloadRecordsChanged();
  return downloadRecordsResult();
}

function broadcastDownloadRecordsChanged() {
  const result = downloadRecordsResult();
  emitIpcEvent("baidu-netdisk:downloads:changed", result);
}

export function registerBaiduNetdiskPlatformHandlers() {
  ipcMain.handle(
    "baidu-netdisk:config:get",
    (): BaiduNetdiskConfigResult => ({
      config: readConfig(),
      path: configPath(),
    }),
  );

  ipcMain.handle("baidu-netdisk:config:select-executable", async (event) => {
    const currentConfig = readConfig();
    const selectedPath = await selectDirectory(event, {
      title: "选择百度网盘启动文件",
      defaultPath: currentConfig.executablePath || undefined,
      properties: ["openFile"],
      filters: [{ name: "百度网盘启动文件", extensions: ["exe"] }],
    });

    if (!selectedPath) return null;
    const config = normalizeConfig({
      ...currentConfig,
      executablePath: selectedPath,
    });
    writeConfig(config);
    return { config, path: configPath() } satisfies BaiduNetdiskConfigResult;
  });

  ipcMain.handle("baidu-netdisk:config:save", (_event, config: Partial<BaiduNetdiskConfig>) => {
    const nextConfig = normalizeConfig({
      ...readConfig(),
      ...config,
    });

    writeConfig(nextConfig);

    return {
      config: nextConfig,
      path: configPath(),
    } satisfies BaiduNetdiskConfigResult;
  });

  ipcMain.handle("baidu-netdisk:service:status", () => status());
  ipcMain.handle("baidu-netdisk:service:start-cdp", () => startCdp(false));
  ipcMain.handle("baidu-netdisk:service:restart-cdp", () => startCdp(true));
  ipcMain.handle("baidu-netdisk:downloads:list", () => downloadRecordsResult());
  ipcMain.handle("baidu-netdisk:downloads:clear", () => clearDownloadRecords());
  ipcMain.handle("baidu-netdisk:downloads:control", (_event, request: { targetName: string; action: "pause" | "resume" | "delete" }) =>
    controlDownloadTask(request.targetName, request.action),
  );
  ipcMain.handle("baidu-netdisk:share:download", (_event, request) =>
    downloadShare(request as BaiduNetdiskShareDownloadRequest | undefined),
  );
  ipcMain.handle("baidu-netdisk:share:ensure-downloaded", (_event, request) =>
    ensureBaiduNetdiskShareDownloaded(
      withAppVideoTranscode(request as BaiduNetdiskEnsureDownloadedRequest),
    ),
  );

  setTimeout(() => {
    void recoverPendingRemoteTransferCleanups();
  }, 1_000);
}
