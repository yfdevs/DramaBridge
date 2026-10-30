import path from "node:path";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import {
  collectEpisodeDirectorySummaries,
  classifyOwnershipProjectProofName,
  composeOwnershipMaterialsIntoTwo,
  episodeFileSummary,
  fileSetSignature,
  hasRequiredOwnershipMaterials,
  isOwnershipDirectoryName,
  isExplicitNonOwnershipImageDirectoryPath,
  isOwnershipScreenshotCandidateDirectory,
  isCompleteEpisodeFileSet,
  listDirectLocalEpisodeFiles,
  listLocalEpisodeFiles,
  listLocalAiProductionProofFiles,
  listLocalOwnershipMaterials,
  listLocalPosterImages,
  playletDir,
  standardizeEpisodeFilesToRoot,
  standardizeOwnershipMaterialsToRoot,
  standardizePosterImagesToRoot,
  standardizeAiProductionProofFilesToRoot,
  type LocalEpisodeFile,
  type SelectedEpisodeFileIdentity,
  type LocalOwnershipMaterialSet,
  type LocalPosterImageFile,
  type LocalAiProductionProofFile,
  type OwnershipMaterialRequirements,
} from "./index.js";

export type BaiduNetdiskShareInfo = {
  link: string;
  pwd: string;
  name: string;
};

export type BaiduNetdiskShareDownloadResult = {
  share: BaiduNetdiskShareInfo;
  downloadRoot?: string;
  localPath?: string;
  expectedOwnershipImages?: number;
  expectedOwnershipFiles?: number;
  expectedPosterImages?: number;
  expectedAiProductionProofFiles?: number;
  expectedMetadataTextFiles?: number;
  expectedMetadataFiles?: number;
  inferredEpisodeCount?: number;
  remoteVideos?: {
    files: SelectedEpisodeFileIdentity[];
    aiSelectionApplied?: boolean;
  };
  remoteMetadata?: {
    files: Array<{ name: string; path: string; size?: number }>;
    textFiles: Array<{ name: string; path: string; size?: number }>;
    roots: Array<{ path: string; fsId?: number | string }>;
  };
  remoteResourceRoot?: {
    path: string;
    fsId: number | string;
  };
  completed: boolean;
  skippedExisting: boolean;
};

export type BaiduNetdiskDownloadTaskStatus = {
  found: boolean;
  name?: string;
  localPath?: string;
  status?: string;
  size?: number;
  finishSize?: number;
  rate?: string;
  completed: boolean;
  tasks: string[];
};

export type BaiduNetdiskEpisodeVideoProgress = {
  phase: "existing-complete" | "download-submitted" | "downloading" | "standardized" | "scan";
  localPath?: string;
  downloadRoot?: string;
  nativeStatus?: string;
  speedText?: string;
  progressPercent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  skippedExisting?: boolean;
};

export type EnsureBaiduNetdiskEpisodeVideosOptions = {
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot: string;
  episodeCount?: number;
  /** Download only episodes 1..N. This is opt-in and does not change normal platform downloads. */
  episodeDownloadLimit?: number;
  inferEpisodeCount?: boolean;
  downloadEpisodeVideos?: boolean;
  downloadAssetMaterials?: boolean;
  forceAssetDownload?: boolean;
  requiredOwnership?: OwnershipMaterialRequirements;
  requiredOwnershipFiles?: number;
  requiredPosterImages?: number;
  requiredAiProductionProofFiles?: number;
  requiredMetadataTextFiles?: number;
  /** Wait for every remotely discovered optional asset instead of only caller requirements. */
  requireAllDiscoveredAssets?: boolean;
  mergeOwnershipMaterials?: boolean;
  downloadDir?: string;
  downloadTaskName?: string;
  sourceLocalPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stableCompletePolls?: number;
  signal?: AbortSignal;
  downloadShare: (request: {
    shareText: string;
    resourceName: string;
    expectedEpisodeCount?: number;
    episodeDownloadLimit?: number;
    inferEpisodeCount?: boolean;
    expectedOwnershipCounts?: OwnershipMaterialRequirements;
    expectedOwnershipFiles?: number;
    expectedPosterImages?: number;
    expectedAiProductionProofFiles?: number;
    expectedMetadataTextFiles?: number;
    downloadEpisodeVideos?: boolean;
    downloadAssetMaterials?: boolean;
    requireAllDiscoveredAssets?: boolean;
    downloadDir: string;
  }) => Promise<BaiduNetdiskShareDownloadResult>;
  getDownloadTaskStatus?: (request: {
    targetName: string;
    targetNames?: string[];
    expectedDownloadRoot?: string;
  }) => Promise<BaiduNetdiskDownloadTaskStatus | undefined>;
  cancelDownloadTask?: (request: {
    targetName: string;
    downloadRoot?: string;
  }) => Promise<void>;
  onStableEpisodeFiles?: (files: LocalEpisodeFile[]) => void;
  onProgress?: (progress: BaiduNetdiskEpisodeVideoProgress) => void | Promise<void>;
  onLog?: (message: string) => void;
};

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("任务已终止。");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type EnsureBaiduNetdiskEpisodeVideosResult = {
  localPath: string;
  episodeCount: number;
  skippedExisting: boolean;
  completed: boolean;
};

export function resolveBaiduNetdiskAssetCompletionRequirements(options: {
  requiredOwnershipImages?: number;
  requiredOwnershipFiles?: number;
  requiredPosterImages?: number;
  requiredAiProductionProofFiles?: number;
  discoveredOwnershipImages?: number;
  discoveredOwnershipFiles?: number;
  discoveredPosterImages?: number;
  discoveredAiProductionProofFiles?: number;
  requiredMetadataTextFiles?: number;
  discoveredMetadataFiles?: number;
  requireAllDiscoveredAssets?: boolean;
}) {
  const count = (value: number | undefined) =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
  const requiredCount = (required: number | undefined, discovered: number | undefined) => {
    const normalizedRequired = count(required);
    return options.requireAllDiscoveredAssets
      ? Math.max(normalizedRequired, count(discovered))
      : normalizedRequired;
  };

  return {
    ownershipImages: requiredCount(
      options.requiredOwnershipImages,
      options.discoveredOwnershipImages,
    ),
    ownershipFiles: requiredCount(
      options.requiredOwnershipFiles,
      options.discoveredOwnershipFiles,
    ),
    posterImages: requiredCount(
      options.requiredPosterImages,
      options.discoveredPosterImages,
    ),
    aiProductionProofFiles: requiredCount(
      options.requiredAiProductionProofFiles,
      options.discoveredAiProductionProofFiles,
    ),
    metadataFiles: requiredCount(
      options.requiredMetadataTextFiles,
      options.discoveredMetadataFiles,
    ),
  };
}

function taskProgressPercent(finishSize?: number, size?: number) {
  if (!Number.isFinite(finishSize) || !Number.isFinite(size) || !size || size <= 0) {
    return undefined;
  }

  return Math.round(Math.min(Math.max((finishSize! / size) * 100, 0), 1000)) / 10;
}

function normalizeDownloadProgress(transferredBytes: number, totalBytes: number | undefined) {
  if (!Number.isFinite(transferredBytes) || transferredBytes <= 0) {
    return {
      progressPercent: undefined,
      transferredBytes: undefined,
      totalBytes:
        Number.isFinite(totalBytes) && totalBytes && totalBytes > 0 ? totalBytes : undefined,
    };
  }

  if (!Number.isFinite(totalBytes) || !totalBytes || totalBytes <= 0) {
    return {
      progressPercent: undefined,
      transferredBytes,
      totalBytes: undefined,
    };
  }

  if (transferredBytes > totalBytes) {
    return {
      progressPercent: undefined,
      transferredBytes,
      totalBytes: undefined,
    };
  }

  return {
    progressPercent: taskProgressPercent(transferredBytes, totalBytes),
    transferredBytes,
    totalBytes,
  };
}

function samePath(left: string, right: string) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function currentDownloadLocalPaths(
  paths: Array<string | undefined>,
  targetRoot: string,
  resourceName: string,
) {
  const standardTargetDir = playletDir(targetRoot, resourceName);
  const normalized = paths
    .filter((item): item is string => Boolean(item?.trim()))
    .map((item) => path.resolve(item));
  const nonStandard = normalized.filter((item) => !samePath(item, standardTargetDir));
  const candidates = nonStandard.length > 0 ? nonStandard : normalized;

  return [...new Map(candidates.map((item) => [item.toLowerCase(), item])).values()];
}

async function localEpisodeCandidateDirs(localPath: string) {
  const baseDir = localPath;
  return [
    baseDir,
    path.join(baseDir, "成片"),
    path.join(baseDir, "成品"),
    path.join(baseDir, "视频"),
    path.join(baseDir, "正片"),
  ];
}

async function listCurrentDownloadEpisodeFiles(
  localPaths: string[],
  targetRoot: string,
  resourceName: string,
  selectedEpisodeFiles?: SelectedEpisodeFileIdentity[],
) {
  const candidates: Array<{ label: string; files: LocalEpisodeFile[] }> = [];
  const seenDirs = new Set<string>();

  for (const localPath of localPaths) {
    for (const dir of await localEpisodeCandidateDirs(localPath)) {
      const key = path.resolve(dir).toLowerCase();
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      candidates.push({
        label: dir,
        files: await listDirectLocalEpisodeFiles(dir, resourceName, selectedEpisodeFiles),
      });
    }
    candidates.push({
      label: `${localPath} (recursive)`,
      files: await listLocalEpisodeFiles({
        root: localPath,
        resourceName,
        allowArbitraryDir: true,
        selectedEpisodeFiles,
      }),
    });
  }

  if (candidates.length <= 0) {
    candidates.push({
      label: playletDir(targetRoot, resourceName),
      files: await listLocalEpisodeFiles({
        root: targetRoot,
        resourceName,
        selectedEpisodeFiles,
      }),
    });
  }

  return (
    candidates.sort(
      (left, right) =>
        right.files.length - left.files.length || left.label.localeCompare(right.label),
    )[0]?.files ?? []
  );
}

async function listCurrentOwnershipMaterials(
  localPaths: string[],
  targetRoot: string,
  resourceName: string,
  deduplicateByContent = true,
  includePortraitImages = false,
): Promise<LocalOwnershipMaterialSet> {
  const downloaded: LocalOwnershipMaterialSet = [];
  const seen = new Set<string>();

  for (const localPath of localPaths) {
    const key = path.resolve(localPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const materials = await listLocalOwnershipMaterials({
      root: localPath,
      resourceName,
      rootIsResourceDir: true,
      deduplicateByContent,
      includePortraitImages,
    });
    downloaded.push(...materials);
  }

  // Once a downloaded ownership directory is present, treat that complete directory as
  // authoritative. Mixing previously standardized copies back in would duplicate images.
  const standardOwnershipDir = path.join(playletDir(targetRoot, resourceName), "权属文件");
  const externalDownloaded = downloaded.filter((file) => {
    const relative = path.relative(standardOwnershipDir, file.file);
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  const combined = externalDownloaded.length > 0
    ? externalDownloaded
    : downloaded.length > 0
      ? downloaded
    : await listLocalOwnershipMaterials({
        root: targetRoot,
        resourceName,
        deduplicateByContent,
        includePortraitImages,
      });
  return [...new Map(
    combined.map((file) => [path.resolve(file.file).toLowerCase(), file]),
  ).values()];
}

type LocalRawOwnershipFile = {
  file: string;
  size: number;
  modifiedAtMs: number;
};

async function listCurrentRawOwnershipFiles(
  localPaths: string[],
  targetRoot: string,
  resourceName: string,
) {
  const files = new Map<string, LocalRawOwnershipFile>();
  const roots = [...new Set([
    ...localPaths,
    playletDir(targetRoot, resourceName),
  ].map((item) => path.resolve(item)))];
  const walk = async (
    directory: string,
    inOwnershipDirectory: boolean,
    depth: number,
  ): Promise<void> => {
    if (depth > 8) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const currentOwnershipScope = inOwnershipDirectory
      || (!isExplicitNonOwnershipImageDirectoryPath(path.relative(playletDir(targetRoot, resourceName), directory))
        && isOwnershipScreenshotCandidateDirectory(entries));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(
          file,
          currentOwnershipScope || isOwnershipDirectoryName(entry.name),
          depth + 1,
        );
      } else if (
        currentOwnershipScope
        && entry.isFile()
        && /\.(?:jpe?g|png|bmp|webp|pdf)$/i.test(entry.name)
      ) {
        const info = await stat(file).catch(() => undefined);
        if (info?.isFile() && info.size > 0) {
          files.set(path.resolve(file).toLowerCase(), {
            file,
            size: info.size,
            modifiedAtMs: info.mtimeMs,
          });
        }
      }
    }
  };
  for (const root of roots) {
    await walk(root, isOwnershipDirectoryName(path.basename(root)), 0);
  }
  return [...files.values()].sort((left, right) =>
    left.file.localeCompare(right.file, "zh-CN", { numeric: true })
  );
}

async function listCurrentPosterImages(
  localPaths: string[],
  targetRoot: string,
  resourceName: string,
): Promise<LocalPosterImageFile[]> {
  const downloaded: LocalPosterImageFile[] = [];
  const seen = new Set<string>();
  for (const localPath of localPaths) {
    const key = path.resolve(localPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    downloaded.push(...await listLocalPosterImages({
      root: localPath,
      resourceName,
      rootIsResourceDir: true,
      includeAllMatches: true,
    }));
  }

  const standardPosterDir = path.join(playletDir(targetRoot, resourceName), "海报封面");
  const externalDownloaded = downloaded.filter((file) => {
    const relative = path.relative(standardPosterDir, file.file);
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  return externalDownloaded.length > 0
    ? externalDownloaded
    : downloaded.length > 0
      ? downloaded
      : listLocalPosterImages({ root: targetRoot, resourceName, includeAllMatches: true });
}

async function listCurrentAiProductionProofFiles(
  localPaths: string[],
  targetRoot: string,
  resourceName: string,
): Promise<LocalAiProductionProofFile[]> {
  const downloaded: LocalAiProductionProofFile[] = [];
  const seen = new Set<string>();
  for (const localPath of localPaths) {
    const key = path.resolve(localPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    downloaded.push(...await listLocalAiProductionProofFiles({
      root: localPath,
      resourceName,
      rootIsResourceDir: true,
    }));
  }
  return downloaded.length > 0
    ? downloaded
    : listLocalAiProductionProofFiles({ root: targetRoot, resourceName });
}

type LocalMetadataFile = {
  file: string;
  name: string;
  size: number;
  modifiedAtMs: number;
  isText: boolean;
};

async function listCurrentMetadataFiles(
  localPaths: string[],
  targetRoot: string,
  resourceName: string,
  directoryNames: string[] = [],
) {
  const standardResourceDir = playletDir(targetRoot, resourceName);
  const roots = new Map<string, string>();
  const addRoot = (value: string) => roots.set(path.resolve(value).toLowerCase(), value);
  const expectedDirectoryNames = new Set(
    directoryNames
      .map((value) => path.basename(value.trim()))
      .filter((value) => value && value !== "." && value !== ".."),
  );
  addRoot(path.join(standardResourceDir, "海报封面", "剧情资料"));
  addRoot(path.join(standardResourceDir, "海报封面", "原始图片"));
  for (const localPath of localPaths) {
    for (const directoryName of expectedDirectoryNames) {
      if (path.basename(localPath) === directoryName) addRoot(localPath);
      addRoot(path.join(localPath, directoryName));
      addRoot(path.join(localPath, resourceName, directoryName));
    }
  }

  // A shared folder can contain an uploader-prefixed wrapper (for example
  // `A刘晓-剧名/简介`) whose name is different from the task's resourceName.
  // Search only inside this task's download roots and only for directory names
  // that the remote metadata listing explicitly reported.
  const findNestedMetadataRoots = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || expectedDirectoryNames.size === 0) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nestedDirectory = path.join(directory, entry.name);
      if (expectedDirectoryNames.has(entry.name)) {
        addRoot(nestedDirectory);
        continue;
      }
      await findNestedMetadataRoots(nestedDirectory, depth + 1);
    }
  };
  for (const localPath of localPaths) await findNestedMetadataRoots(localPath, 0);

  const files = new Map<string, LocalMetadataFile>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(?:txt|md|docx?|rtf|png|jpe?g|bmp|webp)$/i.test(entry.name)) continue;
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile() || info.size <= 0) continue;
      files.set(path.resolve(file).toLowerCase(), {
        file,
        name: entry.name,
        size: info.size,
        modifiedAtMs: info.mtimeMs,
        isText: /\.(?:txt|md|docx?|rtf)$/i.test(entry.name),
      });
    }
  };
  for (const root of roots.values()) await walk(root, 0);
  return [...files.values()].sort((left, right) =>
    left.file.localeCompare(right.file, "zh-CN", { numeric: true })
  );
}

function ownershipSignature(materials: LocalOwnershipMaterialSet) {
  return materials
    .map((file) => `${file.file}:${file.size}`)
    .join("|");
}

function rawOwnershipSignature(files: LocalRawOwnershipFile[]) {
  return files.map((file) => `${file.file}:${file.size}:${file.modifiedAtMs}`).join("|");
}

async function preserveOwnershipDocuments(options: {
  files: LocalRawOwnershipFile[];
  targetRoot: string;
  resourceName: string;
  onLog?: (message: string) => void;
}) {
  const documents = options.files.filter((file) => path.extname(file.file).toLowerCase() === ".pdf");
  if (documents.length === 0) return;
  const targetDir = path.join(playletDir(options.targetRoot, options.resourceName), "权属文件");
  await mkdir(targetDir, { recursive: true });
  for (const document of documents) {
    const relative = path.relative(targetDir, document.file);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) continue;
    const parsed = path.parse(path.basename(document.file));
    let target = path.join(targetDir, parsed.base);
    let suffix = 1;
    while (true) {
      const existing = await stat(target).catch(() => undefined);
      if (!existing) break;
      if (existing.size === document.size) {
        target = "";
        break;
      }
      target = path.join(targetDir, `${parsed.name}-${suffix}${parsed.ext}`);
      suffix += 1;
    }
    if (target) await copyFile(document.file, target);
  }
  options.onLog?.(`[video-assets] 权属 PDF 持久化完成：文件=${documents.length} dir=${targetDir}`);
}

function posterSignature(files: LocalPosterImageFile[]) {
  return files.map((file) => `${file.file}:${file.size}`).join("|");
}

function aiProductionProofSignature(files: LocalAiProductionProofFile[]) {
  return files.map((file) => `${file.file}:${file.size}`).join("|");
}

function metadataSignature(files: LocalMetadataFile[]) {
  return files.map((file) => `${file.file}:${file.size}:${file.modifiedAtMs}`).join("|");
}

async function standardizeCompleteResources(options: {
  files: LocalEpisodeFile[];
  ownership: LocalOwnershipMaterialSet;
  rawOwnershipFiles: LocalRawOwnershipFile[];
  posters: LocalPosterImageFile[];
  aiProductionProofs: LocalAiProductionProofFile[];
  metadataFiles: LocalMetadataFile[];
  ownershipRequirements: OwnershipMaterialRequirements;
  targetRoot: string;
  resourceName: string;
  standardizeEpisodeVideos?: boolean;
  onLog?: (message: string) => void;
}) {
  await standardizeOwnershipMaterialsToRoot({
    materials: options.ownership,
    requirements: options.ownershipRequirements,
    targetRoot: options.targetRoot,
    resourceName: options.resourceName,
    onLog: options.onLog,
  });
  await preserveOwnershipDocuments({
    files: options.rawOwnershipFiles,
    targetRoot: options.targetRoot,
    resourceName: options.resourceName,
    onLog: options.onLog,
  });
  await standardizePosterImagesToRoot({
    files: options.posters,
    metadataSourceFiles: options.metadataFiles.map((file) => file.file),
    targetRoot: options.targetRoot,
    resourceName: options.resourceName,
    onLog: options.onLog,
  });
  if (options.aiProductionProofs.length > 0) {
    await standardizeAiProductionProofFilesToRoot({
      files: options.aiProductionProofs,
      targetRoot: options.targetRoot,
      resourceName: options.resourceName,
      onLog: options.onLog,
    });
  }
  if (options.standardizeEpisodeVideos !== false) {
    return standardizeEpisodeFilesToRoot({
      files: options.files,
      targetRoot: options.targetRoot,
      resourceName: options.resourceName,
      onLog: options.onLog,
    });
  }
  return playletDir(options.targetRoot, options.resourceName);
}

async function composeStandardizedOwnershipMaterials(options: {
  targetRoot: string;
  resourceName: string;
  requirements: OwnershipMaterialRequirements;
}) {
  const materials = await listLocalOwnershipMaterials({ root: options.targetRoot, resourceName: options.resourceName });
  const selected = materials;
  if (selected.length === 0) return undefined;
  const output = await composeOwnershipMaterialsIntoTwo({
    files: selected,
    outputDir: path.join(playletDir(options.targetRoot, options.resourceName), "权属文件"),
    resourceName: options.resourceName,
  });
  return output;
}

async function logEpisodeDirectoryDetails(options: {
  root: string;
  resourceName: string;
  episodeCount: number;
  reason: string;
  recursive?: boolean;
  onLog?: (message: string) => void;
}) {
  options.onLog?.(
    `[video-assets] 本地剧集目录扫描：reason=${options.reason} root=${options.root} resource=${options.resourceName} expected=${options.episodeCount}`,
  );
  const summaries = await collectEpisodeDirectorySummaries({
    root: options.root,
    resourceName: options.resourceName,
    recursive: options.recursive,
  });
  const logged = summaries.slice(0, 8);

  if (logged.length <= 0) {
    options.onLog?.(
      options.recursive
        ? `[video-assets] 本地目录详情：${options.root} 未发现可读取目录或文件`
        : `[video-assets] 本地标准目录未发现完整文件：${playletDir(options.root, options.resourceName)}`,
    );
    return;
  }

  for (const summary of logged) {
    const sample = summary.matchedMp4.slice(0, 5).join(" | ") || "无";
    const unmatched =
      summary.unmatchedMp4.length > 0 ? ` unmatched=${summary.unmatchedMp4.length}` : "";
    options.onLog?.(
      `[video-assets] 本地目录：${summary.dir} 文件=${summary.fileCount} 目录=${summary.directoryCount}` +
      ` matched=${summary.matchedMp4.length}/${options.episodeCount} 示例=${sample}${unmatched}`,
    );
  }
}

async function waitForCompleteLocalEpisodeVideos(options: {
  targetRoot: string;
  resourceName: string;
  episodeCount: number;
  requireEpisodeVideos: boolean;
  ownershipRequirements: OwnershipMaterialRequirements;
  requiredOwnershipFiles: number;
  requiredPosterImages: number;
  requiredAiProductionProofFiles: number;
  requiredMetadataTextFiles: number;
  mergeOwnershipMaterials?: boolean;
  sourceLocalPath?: string;
  assetSourceLocalPath?: string;
  downloadTaskName?: string;
  downloadTaskNames?: string[];
  expectedDownloadRoot?: string;
  expectedOwnershipImages?: number;
  expectedOwnershipFiles?: number;
  expectedPosterImages?: number;
  expectedAiProductionProofFiles?: number;
  expectedMetadataFiles?: number;
  metadataDirectoryNames?: string[];
  requireAllDiscoveredAssets?: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  stableCompletePolls: number;
  selectedEpisodeFiles?: SelectedEpisodeFileIdentity[];
  signal?: AbortSignal;
  getDownloadTaskStatus?: EnsureBaiduNetdiskEpisodeVideosOptions["getDownloadTaskStatus"];
  onStableEpisodeFiles?: EnsureBaiduNetdiskEpisodeVideosOptions["onStableEpisodeFiles"];
  onProgress?: EnsureBaiduNetdiskEpisodeVideosOptions["onProgress"];
  onLog?: EnsureBaiduNetdiskEpisodeVideosOptions["onLog"];
}) {
  const completedDownloadStallPollLimit = 15;
  const missingNativeTaskPollLimit = 3;
  const startedAt = Date.now();
  const assetRequirements = resolveBaiduNetdiskAssetCompletionRequirements({
    requiredOwnershipImages: options.ownershipRequirements.minimumImages,
    requiredOwnershipFiles: options.requiredOwnershipFiles,
    requiredPosterImages: options.requiredPosterImages,
    requiredAiProductionProofFiles: options.requiredAiProductionProofFiles,
    discoveredOwnershipImages: options.expectedOwnershipImages,
    discoveredOwnershipFiles: options.expectedOwnershipFiles,
    discoveredPosterImages: options.expectedPosterImages,
    discoveredAiProductionProofFiles: options.expectedAiProductionProofFiles,
    requiredMetadataTextFiles: options.requiredMetadataTextFiles,
    discoveredMetadataFiles: options.expectedMetadataFiles,
    requireAllDiscoveredAssets: options.requireAllDiscoveredAssets,
  });
  const stableSignatures = new Map<string, { signature: string; count: number }>();
  const stableEpisodeFiles = new Map<string, {
    signature: string;
    count: number;
    dispatchedSignature?: string;
  }>();
  let lastProgressLogAt = 0;
  let stalledEpisodeSignature: string | undefined;
  let stalledEpisodePolls = 0;
  let missingNativeTaskSignature: string | undefined;
  let missingNativeTaskPolls = 0;

  while (Date.now() - startedAt < options.timeoutMs) {
    throwIfAborted(options.signal);
    let localPaths = currentDownloadLocalPaths(
      [options.sourceLocalPath],
      options.targetRoot,
      options.resourceName,
    );
    let assetLocalPaths = currentDownloadLocalPaths(
      [options.assetSourceLocalPath ?? options.sourceLocalPath],
      options.targetRoot,
      options.resourceName,
    );
    let files = await listCurrentDownloadEpisodeFiles(
      localPaths,
      options.targetRoot,
      options.resourceName,
      options.selectedEpisodeFiles,
    );
    const newlyStableFiles: LocalEpisodeFile[] = [];
    for (const file of files) {
      const key = path.resolve(file.file).toLowerCase();
      const signature = `${file.size}:${file.modifiedAtMs}`;
      const previous = stableEpisodeFiles.get(key);
      const current = {
        signature,
        count: previous?.signature === signature ? previous.count + 1 : 1,
        dispatchedSignature: previous?.dispatchedSignature,
      };
      if (
        current.count >= options.stableCompletePolls
        && current.dispatchedSignature !== signature
      ) {
        current.dispatchedSignature = signature;
        newlyStableFiles.push(file);
      }
      stableEpisodeFiles.set(key, current);
    }
    if (newlyStableFiles.length > 0) {
      options.onStableEpisodeFiles?.(newlyStableFiles);
    }
    let complete = !options.requireEpisodeVideos
      || isCompleteEpisodeFileSet(files, options.episodeCount);
    let ownership = await listCurrentOwnershipMaterials(
      assetLocalPaths,
      options.targetRoot,
      options.resourceName,
    );
    let rawOwnershipFiles = await listCurrentOwnershipMaterials(
      assetLocalPaths,
      options.targetRoot,
      options.resourceName,
      false,
      true,
    );
    let ownershipSourceFiles = await listCurrentRawOwnershipFiles(
      assetLocalPaths,
      options.targetRoot,
      options.resourceName,
    );
    let ownershipComplete = hasRequiredOwnershipMaterials(ownership, options.ownershipRequirements);
    let posters = await listCurrentPosterImages(assetLocalPaths, options.targetRoot, options.resourceName);
    let postersComplete = posters.length >= options.requiredPosterImages;
    let aiProductionProofs = await listCurrentAiProductionProofFiles(
      assetLocalPaths,
      options.targetRoot,
      options.resourceName,
    );
    let aiProductionProofsComplete = aiProductionProofs.length >= options.requiredAiProductionProofFiles;
    let metadataFiles = await listCurrentMetadataFiles(
      assetLocalPaths,
      options.targetRoot,
      options.resourceName,
      options.metadataDirectoryNames,
    );
    let metadataComplete = metadataFiles.filter((file) => file.isText).length >= options.requiredMetadataTextFiles
      && metadataFiles.length >= assetRequirements.metadataFiles;
    let signature = `${fileSetSignature(files)}#${ownershipSignature(ownership)}#${rawOwnershipSignature(ownershipSourceFiles)}#${posterSignature(posters)}#${aiProductionProofSignature(aiProductionProofs)}#${metadataSignature(metadataFiles)}`;
    let stableKey = [...localPaths, ...assetLocalPaths].join("|")
      || playletDir(options.targetRoot, options.resourceName);
    let stable = stableSignatures.get(stableKey);
    let nextStable = {
      signature,
      count: complete && ownershipComplete && postersComplete && aiProductionProofsComplete && metadataComplete && stable?.signature === signature
        ? stable.count + 1
        : complete && ownershipComplete && postersComplete && aiProductionProofsComplete && metadataComplete ? 1 : 0,
    };
    stableSignatures.set(stableKey, nextStable);

    const ownershipDirectoryComplete =
      rawOwnershipFiles.length >= assetRequirements.ownershipImages
      && ownershipSourceFiles.length >= assetRequirements.ownershipFiles;
    const posterDownloadComplete = posters.length >= assetRequirements.posterImages;
    const aiProductionProofDownloadComplete =
      aiProductionProofs.length >= assetRequirements.aiProductionProofFiles;
    if (complete && ownershipComplete && ownershipDirectoryComplete && postersComplete && posterDownloadComplete && aiProductionProofsComplete && aiProductionProofDownloadComplete && metadataComplete && nextStable.count >= options.stableCompletePolls) {
      const completedPath = await standardizeCompleteResources({
        files,
        ownership,
        rawOwnershipFiles: ownershipSourceFiles,
        posters,
        aiProductionProofs,
        metadataFiles,
        ownershipRequirements: options.ownershipRequirements,
        targetRoot: options.targetRoot,
        resourceName: options.resourceName,
        standardizeEpisodeVideos: options.requireEpisodeVideos,
        onLog: options.onLog,
      });
      if (options.mergeOwnershipMaterials) {
        await composeStandardizedOwnershipMaterials({ targetRoot: options.targetRoot, resourceName: options.resourceName, requirements: options.ownershipRequirements });
      }
      return completedPath;
    }

    if (options.getDownloadTaskStatus) {
      const taskStatus = await options.getDownloadTaskStatus({
        targetName: options.downloadTaskName || options.resourceName,
        targetNames: options.downloadTaskNames,
        expectedDownloadRoot: options.expectedDownloadRoot,
      }).catch(() => undefined);

      if (taskStatus) {
        localPaths = currentDownloadLocalPaths(
          [options.sourceLocalPath, taskStatus.localPath],
          options.targetRoot,
          options.resourceName,
        );
        assetLocalPaths = currentDownloadLocalPaths(
          [
            options.assetSourceLocalPath,
            taskStatus.localPath ? path.dirname(taskStatus.localPath) : undefined,
          ],
          options.targetRoot,
          options.resourceName,
        );
        files = await listCurrentDownloadEpisodeFiles(
          localPaths,
          options.targetRoot,
          options.resourceName,
          options.selectedEpisodeFiles,
        );
        const bestLocalSummary = episodeFileSummary(files);
        complete = !options.requireEpisodeVideos
          || isCompleteEpisodeFileSet(files, options.episodeCount);
        ownership = await listCurrentOwnershipMaterials(
          assetLocalPaths,
          options.targetRoot,
          options.resourceName,
        );
        rawOwnershipFiles = await listCurrentOwnershipMaterials(
          assetLocalPaths,
          options.targetRoot,
          options.resourceName,
          false,
          true,
        );
        ownershipSourceFiles = await listCurrentRawOwnershipFiles(
          assetLocalPaths,
          options.targetRoot,
          options.resourceName,
        );
        ownershipComplete = hasRequiredOwnershipMaterials(ownership, options.ownershipRequirements);
        posters = await listCurrentPosterImages(
          assetLocalPaths,
          options.targetRoot,
          options.resourceName,
        );
        postersComplete = posters.length >= options.requiredPosterImages;
        aiProductionProofs = await listCurrentAiProductionProofFiles(
          assetLocalPaths,
          options.targetRoot,
          options.resourceName,
        );
        aiProductionProofsComplete = aiProductionProofs.length >= options.requiredAiProductionProofFiles;
        metadataFiles = await listCurrentMetadataFiles(
          assetLocalPaths,
          options.targetRoot,
          options.resourceName,
          options.metadataDirectoryNames,
        );
        metadataComplete = metadataFiles.filter((file) => file.isText).length >= options.requiredMetadataTextFiles
          && metadataFiles.length >= assetRequirements.metadataFiles;
        signature = `${fileSetSignature(files)}#${ownershipSignature(ownership)}#${rawOwnershipSignature(ownershipSourceFiles)}#${posterSignature(posters)}#${aiProductionProofSignature(aiProductionProofs)}#${metadataSignature(metadataFiles)}`;
        stableKey = [...localPaths, ...assetLocalPaths].join("|")
          || playletDir(options.targetRoot, options.resourceName);
        stable = stableSignatures.get(stableKey);
        nextStable = {
          signature,
          count: complete && ownershipComplete && postersComplete && aiProductionProofsComplete && metadataComplete && stable?.signature === signature
            ? stable.count + 1
            : complete && ownershipComplete && postersComplete && aiProductionProofsComplete && metadataComplete ? 1 : 0,
        };
        stableSignatures.set(stableKey, nextStable);

        const progress = normalizeDownloadProgress(taskStatus.finishSize ?? 0, taskStatus.size);
        await options.onProgress?.({
          phase: "downloading",
          nativeStatus: taskStatus.status,
          speedText: taskStatus.rate,
          localPath: taskStatus.localPath,
          ...progress,
        });

        if (Date.now() - lastProgressLogAt > 15_000) {
          options.onLog?.(
            `[video-assets] 下载状态：${options.resourceName}` +
              (options.requireEpisodeVideos && bestLocalSummary
                ? ` 本地识别=${bestLocalSummary.count}/${options.episodeCount}集` +
                  (bestLocalSummary.min !== undefined
                    ? `(${bestLocalSummary.min}-${bestLocalSummary.max})`
                    : "")
                : "") +
              ` 权属图片=${ownership.length}/${options.ownershipRequirements.minimumImages ?? 0}` +
              ` 权属原始图片=${rawOwnershipFiles.length}/${assetRequirements.ownershipImages}` +
              ` 权属全部文件=${ownershipSourceFiles.length}/${assetRequirements.ownershipFiles}` +
              ` 权属远端发现=${options.expectedOwnershipImages ?? 0}图/${options.expectedOwnershipFiles ?? 0}文件` +
              ` 海报封面=${posters.length}/${options.requiredPosterImages}` +
              ` AI制作证明=${aiProductionProofs.length}/${options.requiredAiProductionProofFiles}` +
              ` 剧情资料=${metadataFiles.filter((file) => file.isText).length}/${options.requiredMetadataTextFiles}文本，${metadataFiles.length}/${assetRequirements.metadataFiles}全部文件` +
              (taskStatus.rate ? ` ${taskStatus.rate}` : "") +
              (taskStatus.status ? ` status=${taskStatus.status}` : ""),
          );
          lastProgressLogAt = Date.now();
        }

        if (taskStatus.found) {
          missingNativeTaskSignature = undefined;
          missingNativeTaskPolls = 0;
        } else if (options.requireEpisodeVideos && !complete) {
          const currentEpisodeSignature = fileSetSignature(files);
          if (missingNativeTaskSignature === currentEpisodeSignature) {
            missingNativeTaskPolls += 1;
          } else {
            missingNativeTaskSignature = currentEpisodeSignature;
            missingNativeTaskPolls = 1;
          }
          options.onLog?.(
            `[video-assets] 百度网盘客户端未找到已提交的下载任务：${options.downloadTaskName || options.resourceName}`
              + `，连续${missingNativeTaskPolls}/${missingNativeTaskPollLimit}次，本地识别${files.length}/${options.episodeCount}集`,
          );
          if (missingNativeTaskPolls >= missingNativeTaskPollLimit) {
            throw new Error(
              `[download-task-missing] 百度网盘下载任务提交后未出现在客户端传输列表，`
                + `连续${missingNativeTaskPollLimit}次检查均不存在；`
                + `本地识别${files.length}/${options.episodeCount}集。请重新创建下载任务。`,
            );
          }
        }

        const ownershipDirectoryComplete =
          rawOwnershipFiles.length >= assetRequirements.ownershipImages
          && ownershipSourceFiles.length >= assetRequirements.ownershipFiles;
        const posterDownloadComplete = posters.length >= assetRequirements.posterImages;
        const aiProductionProofDownloadComplete =
          aiProductionProofs.length >= assetRequirements.aiProductionProofFiles;
        if (taskStatus.completed && options.requireEpisodeVideos && !complete) {
          const currentEpisodeSignature = fileSetSignature(files);
          if (stalledEpisodeSignature === currentEpisodeSignature) {
            stalledEpisodePolls += 1;
          } else {
            stalledEpisodeSignature = currentEpisodeSignature;
            stalledEpisodePolls = 1;
          }

          if (stalledEpisodePolls >= completedDownloadStallPollLimit) {
            const recognizedIndexes = new Set(files.map((file) => file.index));
            const missingIndexes = Array.from(
              { length: options.episodeCount },
              (_, index) => index + 1,
            ).filter((index) => !recognizedIndexes.has(index));
            throw new Error(
              `[local-video-invalid] 百度网盘下载任务已完成，但本地剧集连续${completedDownloadStallPollLimit}次检查无变化：` +
                `期望${options.episodeCount}集，实际识别${recognizedIndexes.size}集` +
                `${missingIndexes.length > 0 ? `，缺少第${missingIndexes.join("、")}集` : ""}。` +
                "请检查百度网盘下载记录及本地文件名后重试。",
            );
          }
        } else {
          stalledEpisodeSignature = undefined;
          stalledEpisodePolls = 0;
        }
        if (taskStatus.completed && ownershipDirectoryComplete && !ownershipComplete) {
          throw new Error(
            `百度网盘权属材料筛选后数量不足。至少需要${options.ownershipRequirements.minimumImages ?? 0}张非竖图，实际找到${ownership.length}张；高度大于宽度的图片不会作为权属文件。`,
          );
        }
        if (
          (complete && ownershipComplete && ownershipDirectoryComplete && postersComplete && posterDownloadComplete && aiProductionProofsComplete && aiProductionProofDownloadComplete && metadataComplete && nextStable.count >= options.stableCompletePolls)
          || (taskStatus.completed && complete && ownershipComplete && ownershipDirectoryComplete && postersComplete && posterDownloadComplete && aiProductionProofsComplete && aiProductionProofDownloadComplete && metadataComplete)
        ) {
          const completedPath = await standardizeCompleteResources({
            files,
            ownership,
            rawOwnershipFiles: ownershipSourceFiles,
            posters,
            aiProductionProofs,
            metadataFiles,
            ownershipRequirements: options.ownershipRequirements,
            targetRoot: options.targetRoot,
            resourceName: options.resourceName,
            standardizeEpisodeVideos: options.requireEpisodeVideos,
            onLog: options.onLog,
          });
          if (options.mergeOwnershipMaterials) {
            await composeStandardizedOwnershipMaterials({ targetRoot: options.targetRoot, resourceName: options.resourceName, requirements: options.ownershipRequirements });
          }
          return completedPath;
        }
      }
    }

    await waitWithSignal(options.pollIntervalMs, options.signal);
  }

  for (const root of [options.targetRoot, options.sourceLocalPath].filter(
    (item): item is string => Boolean(item?.trim()),
  )) {
    await logEpisodeDirectoryDetails({
      root,
      resourceName: options.resourceName,
      episodeCount: options.episodeCount,
      reason: "等待下载完成超时",
      onLog: options.onLog,
    });
  }

  throw new Error(
    `等待百度网盘资源下载完成超时（${Math.round(options.timeoutMs / 6_000) / 10}分钟）：` +
      playletDir(options.targetRoot, options.resourceName),
  );
}

export async function ensureBaiduNetdiskEpisodeVideos(
  options: EnsureBaiduNetdiskEpisodeVideosOptions,
): Promise<EnsureBaiduNetdiskEpisodeVideosResult> {
  throwIfAborted(options.signal);
  const downloadDir = options.downloadDir || options.localEpisodeVideoRoot;
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const stableCompletePolls = options.stableCompletePolls ?? 2;
  const downloadEpisodeVideos = options.downloadEpisodeVideos !== false;
  const requireAllDiscoveredAssets = options.downloadAssetMaterials !== false
    && options.requireAllDiscoveredAssets === true;
  const configuredEpisodeCount = Number(options.episodeCount);
  const hasConfiguredEpisodeCount = Number.isInteger(configuredEpisodeCount)
    && configuredEpisodeCount > 0;
  if (downloadEpisodeVideos && !hasConfiguredEpisodeCount && !options.inferEpisodeCount) {
    throw new Error("剧集数量必须是正整数，或启用自动识别集数。")
  }
  const targetLocalPath = playletDir(options.localEpisodeVideoRoot, options.resourceName);
  const ownershipRequirements = options.requiredOwnership ?? {};
  const requiredOwnershipFiles = Math.max(0, options.requiredOwnershipFiles ?? 0);
  const requiredPosterImages = Math.max(0, options.requiredPosterImages ?? 0);
  const requiredAiProductionProofFiles = Math.max(0, options.requiredAiProductionProofFiles ?? 0);
  const requiredMetadataTextFiles = Math.max(0, options.requiredMetadataTextFiles ?? 0);
  const existingEpisodes = await listLocalEpisodeFiles({
    root: options.localEpisodeVideoRoot,
    resourceName: options.resourceName,
  });
  const expectedExistingEpisodes = options.episodeDownloadLimit === undefined
    ? existingEpisodes
    : existingEpisodes.filter((episode) => episode.index <= options.episodeDownloadLimit!);
  const existingOwnership = await listLocalOwnershipMaterials({
    root: options.localEpisodeVideoRoot,
    resourceName: options.resourceName,
  });
  const existingJianyingOwnershipCount = existingOwnership.filter((material) => (
    classifyOwnershipProjectProofName(`${material.file}/${material.name}`) === "jianying"
  )).length;
  const existingRawOwnershipFiles = await listCurrentRawOwnershipFiles(
    [targetLocalPath],
    options.localEpisodeVideoRoot,
    options.resourceName,
  );
  const existingPosters = await listLocalPosterImages({
    root: options.localEpisodeVideoRoot,
    resourceName: options.resourceName,
  });
  const existingAiProductionProofs = await listLocalAiProductionProofFiles({
    root: options.localEpisodeVideoRoot,
    resourceName: options.resourceName,
  });
  const existingMetadataFiles = await listCurrentMetadataFiles(
    [],
    options.localEpisodeVideoRoot,
    options.resourceName,
  );

  if (
    !options.forceAssetDownload
    &&
    (!downloadEpisodeVideos || (
      hasConfiguredEpisodeCount
      && isCompleteEpisodeFileSet(expectedExistingEpisodes, configuredEpisodeCount)
    ))
    && hasRequiredOwnershipMaterials(existingOwnership, ownershipRequirements)
    && existingRawOwnershipFiles.length >= requiredOwnershipFiles
    && existingPosters.length >= requiredPosterImages
    && existingAiProductionProofs.length >= requiredAiProductionProofFiles
    && existingMetadataFiles.filter((file) => file.isText).length >= requiredMetadataTextFiles
  ) {
    if (options.mergeOwnershipMaterials) {
      await composeStandardizedOwnershipMaterials({ targetRoot: options.localEpisodeVideoRoot, resourceName: options.resourceName, requirements: ownershipRequirements });
    }
    await options.onProgress?.({
      phase: "existing-complete",
      localPath: targetLocalPath,
      skippedExisting: true,
      progressPercent: 100,
    });
    return {
      localPath: targetLocalPath,
      episodeCount: configuredEpisodeCount,
      skippedExisting: true,
      completed: true,
    };
  }

  if (downloadEpisodeVideos && hasConfiguredEpisodeCount) {
    await logEpisodeDirectoryDetails({
      root: options.localEpisodeVideoRoot,
      resourceName: options.resourceName,
      episodeCount: configuredEpisodeCount,
      reason: "启动前未发现完整文件",
      onLog: options.onLog,
    });
  }
  await options.onProgress?.({ phase: "scan", localPath: targetLocalPath });

  const result = await abortable(options.downloadShare({
    shareText: options.shareText,
    resourceName: options.resourceName,
    expectedEpisodeCount: !downloadEpisodeVideos
      || !hasConfiguredEpisodeCount
      || isCompleteEpisodeFileSet(expectedExistingEpisodes, configuredEpisodeCount)
      ? undefined
      : configuredEpisodeCount,
    episodeDownloadLimit: options.episodeDownloadLimit,
    inferEpisodeCount: options.inferEpisodeCount === true,
    expectedOwnershipCounts: {
      minimumImages: Math.max(
        0,
        (ownershipRequirements.minimumImages ?? 0) - existingOwnership.length,
      ),
      minimumJianyingImages: Math.max(
        0,
        (ownershipRequirements.minimumJianyingImages ?? 0) - existingJianyingOwnershipCount,
      ),
    },
    expectedOwnershipFiles: Math.max(
      0,
      requiredOwnershipFiles - existingRawOwnershipFiles.length,
    ),
    expectedPosterImages: Math.max(0, requiredPosterImages - existingPosters.length),
    expectedAiProductionProofFiles: Math.max(
      0,
      requiredAiProductionProofFiles - existingAiProductionProofs.length,
    ),
    expectedMetadataTextFiles: Math.max(
      0,
      requiredMetadataTextFiles - existingMetadataFiles.filter((file) => file.isText).length,
    ),
    downloadEpisodeVideos,
    downloadAssetMaterials: options.downloadAssetMaterials,
    requireAllDiscoveredAssets,
    downloadDir,
  }), options.signal);
  throwIfAborted(options.signal);

  const resolvedEpisodeCount = hasConfiguredEpisodeCount
    ? configuredEpisodeCount
    : Number(result.inferredEpisodeCount);
  if (
    downloadEpisodeVideos
    && (!Number.isInteger(resolvedEpisodeCount) || resolvedEpisodeCount <= 0)
  ) {
    throw new Error("百度网盘资源检查完成，但未能确定有效总集数。")
  }

  await options.onProgress?.({
    phase: "download-submitted",
    localPath: result.localPath,
    downloadRoot: result.downloadRoot,
    skippedExisting: result.skippedExisting,
  });

  let completedPath: string;
  try {
    completedPath = await waitForCompleteLocalEpisodeVideos({
      targetRoot: options.localEpisodeVideoRoot,
      // The ownership directory is downloaded alongside the selected video directory;
      // scan the download root as well so both materials are standardized together.
      sourceLocalPath: result.localPath
        ? result.localPath
        : result.downloadRoot ?? options.sourceLocalPath,
      assetSourceLocalPath: result.localPath
        ? path.dirname(result.localPath)
        : result.downloadRoot ?? options.sourceLocalPath,
      resourceName: options.resourceName,
      downloadTaskName: result.share.name || options.downloadTaskName || options.resourceName,
      downloadTaskNames: options.episodeDownloadLimit !== undefined ? result.remoteVideos?.files.map(file => file.name) : undefined,
      expectedDownloadRoot: options.episodeDownloadLimit !== undefined ? result.downloadRoot ?? options.downloadDir : undefined,
      expectedOwnershipImages: result.expectedOwnershipImages,
      expectedOwnershipFiles: result.expectedOwnershipFiles,
      expectedPosterImages: result.expectedPosterImages,
      expectedAiProductionProofFiles: result.expectedAiProductionProofFiles,
      expectedMetadataFiles: result.expectedMetadataFiles,
      metadataDirectoryNames: result.remoteMetadata?.roots
        .map((root) => path.basename(root.path))
        .filter(Boolean),
      requireAllDiscoveredAssets,
      episodeCount: downloadEpisodeVideos ? resolvedEpisodeCount : 0,
      requireEpisodeVideos: downloadEpisodeVideos,
      ownershipRequirements,
      requiredOwnershipFiles,
      requiredPosterImages,
      requiredAiProductionProofFiles,
      requiredMetadataTextFiles,
      mergeOwnershipMaterials: options.mergeOwnershipMaterials,
      timeoutMs,
      pollIntervalMs,
      stableCompletePolls,
      selectedEpisodeFiles: result.remoteVideos?.aiSelectionApplied
        ? result.remoteVideos.files
        : undefined,
      signal: options.signal,
      getDownloadTaskStatus: options.getDownloadTaskStatus,
      onStableEpisodeFiles: options.onStableEpisodeFiles,
      onProgress: options.onProgress,
      onLog: options.onLog,
    });
  } catch (error) {
    if (options.signal?.aborted && options.cancelDownloadTask) {
      await options.cancelDownloadTask({
        targetName: result.share.name || options.downloadTaskName || options.resourceName,
        downloadRoot: result.downloadRoot,
      }).catch(() => undefined);
    }
    throw error;
  }

  await options.onProgress?.({
    phase: "standardized",
    localPath: completedPath,
    progressPercent: 100,
  });

  return {
    localPath: completedPath,
    episodeCount: downloadEpisodeVideos ? resolvedEpisodeCount : 0,
    skippedExisting: result.skippedExisting,
    completed: true,
  };
}
