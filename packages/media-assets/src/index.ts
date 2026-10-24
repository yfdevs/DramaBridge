import { pathExists, safeFileName } from "@dramabridge/file-utils";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DramaAiClient } from "@dramabridge/ai";
import sharp from "sharp";

import { classifyOwnershipProjectProofScreenshotWithAi } from "./ownership-project-proof-ai.js";
import { removePathWithRetry, retryFileSystemOperation } from "./filesystem-retry.js";
import { readVideoDurationSeconds } from "./video-transcode.js";

export type LocalEpisodeVideo = {
  index: number;
  title: string;
  file: string;
};

export type LocalEpisodeFile = {
  index: number;
  file: string;
  size: number;
  modifiedAtMs: number;
};

export type SelectedEpisodeFileIdentity = {
  index: number;
  name: string;
  size?: number;
};

export type LocalOwnershipMaterialFile = {
  index?: number;
  name: string;
  file: string;
  size: number;
};

export type OwnershipMaterialRequirements = {
  minimumImages?: number;
  /** Images whose file path or source directory explicitly identifies Jianying/CapCut. */
  minimumJianyingImages?: number;
};

export type LocalOwnershipMaterialSet = LocalOwnershipMaterialFile[];

export type OwnershipProjectProofKind = "jianying" | "juchuang" | "unknown";

export type ClassifiedOwnershipProjectProof = {
  kind: OwnershipProjectProofKind;
  material: LocalOwnershipMaterialFile;
};

export type OwnershipProjectProofSelection = {
  files: string[];
  jianying: LocalOwnershipMaterialFile[];
  juchuang: LocalOwnershipMaterialFile[];
  unknown: LocalOwnershipMaterialFile[];
};

export type LocalPosterImageFile = {
  name: string;
  file: string;
  size: number;
  width?: number;
  height?: number;
};

export const dramaPosterOriginalImageDirectoryName = "原始图片";
export const dramaPosterTextDirectoryName = "剧情资料";
export const dramaPosterSourceManifestFileName = "素材清单.json";

export type LocalAiProductionProofFile = {
  name: string;
  file: string;
  size: number;
};

export type PreparedEpisodeUploadFiles = {
  uploadDir: string;
  files: string[];
  sourceFiles?: string[];
};

export {
  isTransientFileSystemError,
  removePathWithRetry,
  retryFileSystemOperation,
  type FileSystemRetryOptions,
} from "./filesystem-retry.js";
export {
  adjustVideoPlaybackSpeed,
  ensureVideoMinimumDimensions,
  extractRandomVideoFrames,
  prepareEpisodeVideos,
  readVideoDurationSeconds,
  readVideoDimensions,
  readVideoStreamMetadata,
  resolveFfmpegExecutablePath,
  resolveFfprobeExecutablePath,
  selectRandomVideoFrameTimestamps,
  VideoTranscodeQueue,
  type AdjustedVideoPlaybackSpeed,
  type EnsureVideoMinimumDimensionsRequest,
  type ExtractRandomVideoFramesRequest,
  type PreparedVideoFile,
  type VideoDimensions,
  type VideoPlaybackSpeedRequest,
  type VideoSizePolicy,
  type VideoStreamMetadata,
  type VideoTranscodeQueueOptions,
  type VideoTranscodeRequest,
} from "./video-transcode.js";
export {
  compressImageForUpload,
  prepareImageForUpload,
  prepareContainedImageVariant,
  prepareCroppedImageVariant,
  prepareExtractedImageVariant,
  prepareStretchedImageVariant,
  readImageDimensions,
  type ImageCropRegion,
  type ImageCompressionPolicy,
  type ImageDimensions,
  type ImageUploadPolicy,
  type PreparedImageUploadFile,
  type PreparedStretchedImageVariant,
} from "./image-upload.js";
export {
  buildMissingPosterPrompt,
  ensureAiPoster,
  type AiPosterResult,
  type EnsureAiPosterOptions,
} from "./ai-poster.js";
export {
  selectBaiduEpisodePathsWithAi,
  type BaiduEpisodeFilenameCandidate,
  type BaiduEpisodeFilenameSelection,
} from "./baidu-episode-filename-ai.js";
export {
  commercialPosterProhibitedTextGuidance,
  commercialPosterSupportingCopyGuidance,
  evaluateCommercialPosterTextValidation,
  isCommercialPosterTitleDetected,
  isNonBlockingCommercialPosterIssue,
  normalizeCommercialPosterText,
  type CommercialPosterTextValidation,
  type CommercialPosterTextValidationResult,
} from "./poster-text-validation.js";
export {
  cleanupStaleRuntimeArtifacts,
  createRuntimeArtifactLease,
  episodeUploadDirectoryPattern,
  materialUploadDirectoryPattern,
  runtimeArtifactLeaseFileName,
  type RuntimeArtifactCleanupFailure,
  type RuntimeArtifactCleanupOptions,
  type RuntimeArtifactCleanupResult,
} from "./runtime-artifacts.js";
import { createRuntimeArtifactLease } from "./runtime-artifacts.js";

export type EpisodeDirectorySummary = {
  dir: string;
  fileCount: number;
  directoryCount: number;
  matchedMp4: string[];
  unmatchedMp4: string[];
};

const nonRetryableBaiduNetdiskResourceErrorPatterns = [
  "分享文本中没有找到百度网盘链接",
  "分享链接没有解析出",
  "分享提取码校验失败",
  "分享页要求验证码",
  "分享链接不可用",
  "百度网盘账号登录已过期",
  "账户已过期",
  "重新登录",
  "重新登陆",
  "百度网盘剧集视频数量不正确",
  "百度网盘权属材料数量不足",
  "百度网盘权属材料筛选后数量不足",
  "百度网盘海报封面数量不足",
  "百度网盘AI制作证明数量不足",
  "等待百度网盘资源下载完成超时",
  "素材-only 模式不会下载该目录",
  "[local-video-invalid]",
  "剧集视频目录不存在",
  "存在重复集数",
  "剧集文件应按文件名匹配",
] as const;

export function isNonRetryableBaiduNetdiskResourceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return nonRetryableBaiduNetdiskResourceErrorPatterns.some((pattern) => message.includes(pattern));
}

const knownEpisodeSubDirs = ["成片", "成品", "视频", "正片"];
const ownershipDirectoryMarkers = ["工程", "权属", "资质", "版权"] as const;
const ownershipImageExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);
const aiProductionProofExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".pdf"]);
const episodeVideoExtensions = new Set([".mp4", ".mov"]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isOwnershipDirectoryName(value: string) {
  const normalized = value.replace(/\s+/g, "");
  return ownershipDirectoryMarkers.some((marker) => normalized.includes(marker))
    || /剪映|剧创|即梦|jianying|capcut|jimeng|dreamina|AI生成记录|AI创作记录|AI生成过程|AI创作过程/iu
      .test(normalized);
}

export function isOwnershipScreenshotCandidateDirectory(
  entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>,
) {
  if (entries.some((entry) => entry.isDirectory())) return false;
  const files = entries.filter((entry) => entry.isFile());
  return files.filter((entry) => ownershipImageExtensions.has(path.extname(entry.name).toLowerCase())).length >= 2
    && !files.some((entry) => episodeVideoExtensions.has(path.extname(entry.name).toLowerCase()));
}

export function isExplicitNonOwnershipImageDirectoryPath(value: string) {
  return String(value || "")
    .split(/[\\/]+/)
    .some((segment) => /海报|封面|角色头像|人物形象|主形象|演员头像|poster|cover|avatar/iu.test(segment));
}

export function playletDir(root: string, resourceName: string) {
  return path.join(root, resourceName);
}

export function safeEpisodeFileBaseName(value: string) {
  return safeFileName(value, { fallback: "短剧", replacement: " " });
}

export function localEpisodeFilePatterns(resourceName: string) {
  const escapedResourceName = escapeRegExp(resourceName);
  return [
    new RegExp(`^${escapedResourceName}(?:\\s*-\\s*|\\s*)第(\\d+)集.*\\.(?:mp4|mov)$`, "i"),
    new RegExp(`^${escapedResourceName}(?:\\s*-\\s*|\\s*)(\\d+)\\s*集?.*\\.(?:mp4|mov)$`, "i"),
    /^第(\d+)集.*\.(?:mp4|mov)$/i,
    /^(?:ep|episode|e)[\s._-]*(\d+)\.(?:mp4|mov)$/i,
    /^(\d+)\.(?:mp4|mov)$/i,
  ];
}

export function isSupportedEpisodeVideoFileName(fileName: string) {
  return episodeVideoExtensions.has(path.extname(fileName).toLowerCase());
}

export function localEpisodeScanDirs(root: string, resourceName: string) {
  const directory = playletDir(root, resourceName);
  return [directory, ...knownEpisodeSubDirs.map((subDir) => path.join(directory, subDir))];
}

export function matchLocalEpisodeIndex(fileName: string, resourceName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  const leadingOrdinalMatch = stem.match(/^(\d{1,4})\s*[·•・、，,。．._—–-]\s*\S/u);
  if (leadingOrdinalMatch) {
    const leadingIndex = Number(leadingOrdinalMatch[1]);
    if (Number.isInteger(leadingIndex) && leadingIndex > 0) return leadingIndex;
  }

  const match = localEpisodeFilePatterns(resourceName)
    .map((pattern) => pattern.exec(fileName))
    .find((result): result is RegExpExecArray => result !== null);

  if (match) return Number(match[1]);

  const trailingNumberMatch = stem.match(/(\d{1,4})\s*(?:集|episode|ep|e)?\s*$/i);
  if (!trailingNumberMatch) return undefined;

  const index = Number(trailingNumberMatch[1]);
  return Number.isInteger(index) && index > 0 ? index : undefined;
}

export async function listDirectLocalEpisodeFiles(
  scanDir: string,
  resourceName: string,
  selectedEpisodeFiles?: SelectedEpisodeFileIdentity[],
): Promise<LocalEpisodeFile[]> {
  const files: LocalEpisodeFile[] = [];
  const entries = await readdir(scanDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile() || !isSupportedEpisodeVideoFileName(entry.name)) continue;

    const file = path.join(scanDir, entry.name);
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat?.isFile() || fileStat.size <= 0) continue;

    const selectedIdentity = selectedEpisodeFiles?.find((expected) =>
      expected.name.toLowerCase() === entry.name.toLowerCase()
      && (expected.size === undefined || expected.size === fileStat.size)
    );
    if (selectedEpisodeFiles?.length && !selectedIdentity) continue;

    const index = selectedIdentity?.index ?? matchLocalEpisodeIndex(entry.name, resourceName);
    if (index === undefined) continue;

    files.push({ index, file, size: fileStat.size, modifiedAtMs: fileStat.mtimeMs });
  }

  if (selectedEpisodeFiles?.length) {
    return files.sort((left, right) => left.index - right.index || left.file.localeCompare(right.file));
  }

  return (await collapseIdenticalLocalEpisodeAliasesByContent(files)).files;
}

export function collapseIdenticalLocalEpisodeAliases(files: LocalEpisodeFile[]) {
  const retained: LocalEpisodeFile[] = [];
  const ignored: Array<{ kept: LocalEpisodeFile; duplicate: LocalEpisodeFile }> = [];
  const groups = new Map<number, LocalEpisodeFile[]>();

  for (const file of files) {
    const group = groups.get(file.index) ?? [];
    group.push(file);
    groups.set(file.index, group);
  }

  const preference = (file: LocalEpisodeFile) => {
    const name = path.basename(file.file);
    if (/第\s*\d+\s*集/i.test(name)) return 2;
    if (/(?:^|[^a-z])(?:ep|episode|e)[\s._-]*\d+/i.test(name)) return 1;
    return 0;
  };

  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) => preference(right) - preference(left) || left.file.localeCompare(right.file),
    );
    const keptBySize = new Map<number, LocalEpisodeFile>();

    for (const file of ordered) {
      const kept = keptBySize.get(file.size);
      if (kept) ignored.push({ kept, duplicate: file });
      else {
        keptBySize.set(file.size, file);
        retained.push(file);
      }
    }
  }

  return {
    files: retained.sort(
      (left, right) => left.index - right.index || left.file.localeCompare(right.file),
    ),
    ignored,
  };
}

const localEpisodeFingerprintCache = new Map<string, string>();

async function localEpisodeContentFingerprint(file: LocalEpisodeFile) {
  const cacheKey = `${path.resolve(file.file).toLowerCase()}#${file.size}#${file.modifiedAtMs}`;
  const cached = localEpisodeFingerprintCache.get(cacheKey);
  if (cached) return cached;

  const sampleSize = Math.min(64 * 1024, file.size);
  const lastOffset = Math.max(0, file.size - sampleSize);
  const offsets = [...new Set([
    0,
    Math.max(0, Math.floor((file.size - sampleSize) / 2)),
    lastOffset,
  ])];
  const handle = await open(file.file, "r");
  const hash = createHash("sha256").update(String(file.size));
  try {
    for (const offset of offsets) {
      const buffer = Buffer.allocUnsafe(sampleSize);
      const { bytesRead } = await handle.read(buffer, 0, sampleSize, offset);
      hash.update(String(offset));
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }

  const fingerprint = hash.digest("hex");
  if (localEpisodeFingerprintCache.size >= 4_096) {
    const oldest = localEpisodeFingerprintCache.keys().next().value;
    if (oldest) localEpisodeFingerprintCache.delete(oldest);
  }
  localEpisodeFingerprintCache.set(cacheKey, fingerprint);
  return fingerprint;
}

async function collapseIdenticalLocalEpisodeAliasesByContent(files: LocalEpisodeFile[]) {
  const sizeResolution = collapseIdenticalLocalEpisodeAliases(files);
  if (sizeResolution.ignored.length === 0) return sizeResolution;

  const candidates = [...sizeResolution.files, ...sizeResolution.ignored.map((item) => item.duplicate)];
  const retained: LocalEpisodeFile[] = [];
  const ignored: Array<{ kept: LocalEpisodeFile; duplicate: LocalEpisodeFile }> = [];
  const groups = new Map<string, LocalEpisodeFile[]>();
  for (const file of candidates) {
    const key = `${file.index}:${file.size}`;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      retained.push(group[0]);
      continue;
    }

    const fingerprints = await Promise.all(group.map(async (file) => ({
      file,
      fingerprint: await localEpisodeContentFingerprint(file).catch(() => undefined),
    })));
    const keptByFingerprint = new Map<string, LocalEpisodeFile>();
    for (const item of fingerprints) {
      if (!item.fingerprint) {
        retained.push(item.file);
        continue;
      }
      const kept = keptByFingerprint.get(item.fingerprint);
      if (kept) ignored.push({ kept, duplicate: item.file });
      else {
        keptByFingerprint.set(item.fingerprint, item.file);
        retained.push(item.file);
      }
    }
  }

  return {
    files: retained.sort(
      (left, right) => left.index - right.index || left.file.localeCompare(right.file),
    ),
    ignored,
  };
}

export async function recursiveLocalEpisodeScanDirs(root: string, resourceName: string) {
  const dirs = [...localEpisodeScanDirs(root, resourceName)];
  const seen = new Set(dirs.map((dir) => path.resolve(dir).toLowerCase()));
  const queue = [{ dir: root, depth: 0 }];
  const maxDepth = 5;
  const maxDirs = 200;

  while (queue.length > 0 && dirs.length < maxDirs) {
    const current = queue.shift();
    if (!current) continue;
    const resolved = path.resolve(current.dir).toLowerCase();
    if (!seen.has(resolved)) {
      seen.add(resolved);
      dirs.push(current.dir);
    }
    if (current.depth >= maxDepth) continue;

    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return dirs;
}

async function recursiveDirs(root: string) {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const resolved = path.resolve(current).toLowerCase();
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    dirs.push(current);

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }

  return dirs;
}

function ownershipMaterialIndex(fileName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const match = stem.match(/(\d{1,4})\s*$/);
  return match ? Number(match[1]) : undefined;
}

async function deduplicateImagesByContent<T extends { file: string }>(files: T[]) {
  const seenContent = new Set<string>();
  const unique: T[] = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file.file)).digest("hex");
    if (seenContent.has(digest)) continue;
    seenContent.add(digest);
    unique.push(file);
  }
  return unique;
}

export async function listLocalOwnershipMaterials(options: {
  root: string;
  resourceName: string;
  rootIsResourceDir?: boolean;
  deduplicateByContent?: boolean;
  includePortraitImages?: boolean;
}): Promise<LocalOwnershipMaterialSet> {
  const resourceDir = options.rootIsResourceDir ? options.root : playletDir(options.root, options.resourceName);
  const result: LocalOwnershipMaterialSet = [];
  const seenFiles = new Set<string>();

  for (const dir of await recursiveDirs(resourceDir)) {
    const relativeDirectoryPath = path.relative(resourceDir, dir);
    const directoryNames = [path.basename(resourceDir), ...relativeDirectoryPath.split(path.sep)]
      .map((name) => name.replace(/\s+/g, ""));
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const explicitOwnershipScope = directoryNames.some(isOwnershipDirectoryName);
    if (!explicitOwnershipScope && (
      isExplicitNonOwnershipImageDirectoryPath(relativeDirectoryPath)
      || !isOwnershipScreenshotCandidateDirectory(entries)
    )) continue;
    for (const entry of entries) {
      if (!entry.isFile() || !ownershipImageExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (/-权属工程文件合成[12]\.jpg$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const resolved = path.resolve(file).toLowerCase();
      if (seenFiles.has(resolved)) continue;
      const fileStat = await stat(file).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size <= 0) continue;
      if (!options.includePortraitImages) {
        const metadata = await sharp(file).metadata().catch(() => undefined);
        if (metadata?.width && metadata?.height && metadata.height > metadata.width) continue;
      }
      seenFiles.add(resolved);
      result.push({
        index: ownershipMaterialIndex(entry.name),
        name: entry.name,
        file,
        size: fileStat.size,
      });
    }
  }

  result.sort((left, right) =>
    (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name, "zh-CN", { numeric: true })
    || left.file.localeCompare(right.file));
  return options.deduplicateByContent === false
    ? result
    : deduplicateImagesByContent(result);
}

// Cloud vision calls can be slower on first use and multiple proof images are
// classified sequentially. Keep a batch guard without aborting valid work on
// ordinary network latency.
const ownershipProjectProofClassificationTimeoutMs = 5 * 60_000;

const ownershipProjectProofClassificationCache = new Map<string, OwnershipProjectProofKind>();
const ownershipProjectProofAiClassificationVersion = "content-v6-engineering-binary-judgement";

export function classifyOwnershipProjectProofName(
  name: string,
): OwnershipProjectProofKind | undefined {
  const compactName = name.replace(/\s+/g, "");
  const hasJianying = /剪映|jianying|capcut/iu.test(compactName);
  const hasJuchuang = /剧创|即梦|jimeng|dreamina|seedance|seedream/iu.test(compactName);
  if (hasJianying === hasJuchuang) return undefined;
  if (hasJianying) return "jianying";
  if (hasJuchuang) return "juchuang";
  return undefined;
}

async function classifyOwnershipProjectProofContent(
  file: string,
  aiClient?: DramaAiClient,
  classifyLocally?: (file: string) => Promise<OwnershipProjectProofKind>,
  onSource?: (source: "local" | "ai") => void,
) {
  if (classifyLocally) {
    const localKind = await Promise.resolve().then(() => classifyLocally(file)).catch(() => "unknown" as const);
    if (localKind === "jianying" || localKind === "juchuang") {
      onSource?.("local");
      return localKind;
    }
  }
  if (!aiClient) throw new Error("OWNERSHIP_PROJECT_PROOF_AI_CLIENT_REQUIRED");
  onSource?.("ai");
  const fileStat = await stat(file);
  const cacheKey = `${path.resolve(file).toLowerCase()}#${fileStat.size}#${fileStat.mtimeMs}#${ownershipProjectProofAiClassificationVersion}`;
  const cached = ownershipProjectProofClassificationCache.get(cacheKey);
  if (cached) return cached;

  const kind = await classifyOwnershipProjectProofScreenshotWithAi(file, aiClient);
  if (ownershipProjectProofClassificationCache.size >= 512) {
    const oldest = ownershipProjectProofClassificationCache.keys().next().value;
    if (oldest) ownershipProjectProofClassificationCache.delete(oldest);
  }
  if (kind !== "unknown") ownershipProjectProofClassificationCache.set(cacheKey, kind);
  return kind;
}

export async function classifyOwnershipProjectProof(
  file: string,
  nameHint = path.basename(file),
  aiClient?: DramaAiClient,
  classifyLocally?: (file: string) => Promise<OwnershipProjectProofKind>,
): Promise<OwnershipProjectProofKind> {
  // Keep all source directory labels in the hint. Baidu resources often split
  // proof images into nested folders such as 权属文件/剪映工程图/截图/1.png,
  // where the immediate parent and filename contain no platform label.
  const namedKind = classifyOwnershipProjectProofName(`${file}/${nameHint}`);
  if (namedKind) return namedKind;

  return classifyOwnershipProjectProofContent(file, aiClient, classifyLocally);
}

function ownershipProjectProofOrder(
  left: LocalOwnershipMaterialFile,
  right: LocalOwnershipMaterialFile,
) {
  return (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name, "zh-CN", { numeric: true })
    || left.file.localeCompare(right.file);
}

export function selectOwnershipProjectProofFiles(
  classified: ClassifiedOwnershipProjectProof[],
  filesPerKind: number | { jianying: number; juchuang: number } = 2,
): OwnershipProjectProofSelection {
  const required = ownershipProjectProofCounts(filesPerKind);
  const jianyingCount = required.jianying;
  const juchuangCount = required.juchuang;
  const jianying = classified
    .filter((item) => item.kind === "jianying")
    .map((item) => item.material)
    .sort(ownershipProjectProofOrder);
  const juchuang = classified
    .filter((item) => item.kind === "juchuang")
    .map((item) => item.material)
    .sort(ownershipProjectProofOrder);
  const unknown = classified
    .filter((item) => item.kind === "unknown")
    .map((item) => item.material)
    .sort(ownershipProjectProofOrder);

  if (jianying.length < jianyingCount || juchuang.length < juchuangCount) {
    const unknownSummary = unknown.length > 0
      ? ` 未识别文件：${unknown.slice(0, 8).map((item) => item.name).join("、")}${
        unknown.length > 8 ? `等 ${unknown.length} 张` : ""
      }。`
      : "";
    throw new Error(
      "[ownership-project-proof-invalid] 权属工程截图不足："
        + `剪映=${jianying.length}/${jianyingCount}，剧创=${juchuang.length}/${juchuangCount}，`
        + `未识别=${unknown.length}。`
        + `请提供至少 ${jianyingCount} 张剪映工程截图和 ${juchuangCount} 张 AI 剧创工程截图。`
        + "截图可位于不同目录，目录名不限；请核对文件名标注及截图内容。"
        + unknownSummary,
    );
  }

  const selectedJianying = jianying.slice(0, jianyingCount);
  const selectedJuchuang = juchuang.slice(0, juchuangCount);
  return {
    files: [...selectedJianying, ...selectedJuchuang].map((material) => material.file),
    jianying: selectedJianying,
    juchuang: selectedJuchuang,
    unknown,
  };
}

function ownershipProjectProofCounts(filesPerKind: number | { jianying: number; juchuang: number }) {
  const required = typeof filesPerKind === "number"
    ? { jianying: filesPerKind, juchuang: filesPerKind }
    : filesPerKind;
  if (!Number.isSafeInteger(required.jianying) || required.jianying < 1
    || !Number.isSafeInteger(required.juchuang) || required.juchuang < 1) {
    throw new Error("每类权属工程截图数量必须是正整数。");
  }
  return required;
}

export async function findOwnershipProjectProofFiles(options: {
  root: string;
  resourceName: string;
  aiClient?: DramaAiClient;
  filesPerKind?: number | { jianying: number; juchuang: number };
  classifyLocally?: (file: string) => Promise<OwnershipProjectProofKind>;
  /** Use explicit source labels before cloud vision; other callers retain content-first behavior. */
  preferNamedKinds?: boolean;
  onClassificationProgress?: (progress: {
    completed: number;
    fallback?: boolean;
    file: string;
    kind: OwnershipProjectProofKind;
    source?: "name" | "local" | "ai";
    total: number;
  }) => void;
}): Promise<OwnershipProjectProofSelection> {
  const materials = await listLocalOwnershipMaterials({
    root: options.root,
    resourceName: options.resourceName,
    deduplicateByContent: true,
  });
  const groupedCandidates = new Map<string, LocalOwnershipMaterialFile[]>();
  for (const material of materials.sort(ownershipProjectProofOrder)) {
    const directory = path.dirname(material.file).toLowerCase();
    const group = groupedCandidates.get(directory) ?? [];
    group.push(material);
    groupedCandidates.set(directory, group);
  }
  // Try two screenshots per directory before exhausting any single directory.
  // A named 剪映 folder may contain many images while the AI proof is elsewhere.
  const candidates: LocalOwnershipMaterialFile[] = [];
  const groups = [...groupedCandidates.values()];
  const largestGroup = Math.max(0, ...groups.map((group) => group.length));
  for (let offset = 0; offset < largestGroup; offset += 2) {
    for (const group of groups) candidates.push(...group.slice(offset, offset + 2));
  }
  const filesPerKind = ownershipProjectProofCounts(options.filesPerKind ?? 2);
  const classified: ClassifiedOwnershipProjectProof[] = [];
  const deadline = Date.now() + ownershipProjectProofClassificationTimeoutMs;
  let classificationSource: "name" | "local" | "ai" = "name";
  const classifyBeforeDeadline = async (material: LocalOwnershipMaterialFile) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `[ownership-project-proof-ai-timeout] 权属工程截图识别超过 ${
          ownershipProjectProofClassificationTimeoutMs / 1_000
        } 秒。`,
      );
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(
        `[ownership-project-proof-ai-timeout] 权属工程截图识别超时：${material.file}`,
      )), remainingMs);
    });
    return Promise.race([
      options.aiClient || options.classifyLocally
        ? classifyOwnershipProjectProofContent(material.file, options.aiClient, options.classifyLocally, source => { classificationSource = source; })
        : classifyOwnershipProjectProof(material.file, material.name),
      timeoutPromise,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  };
  for (const material of candidates) {
    // Prefer the individual filename over an inherited folder label, and avoid
    // unrelated platform words on ancestor paths outside the resource directory.
    const namedKind = options.preferNamedKinds
      ? classifyOwnershipProjectProofName(material.name) ?? classifyOwnershipProjectProofName(
        path.relative(playletDir(options.root, options.resourceName), material.file),
      )
      : undefined;
    classificationSource = "name";
    const kind = namedKind ?? await classifyBeforeDeadline(material);
    classified.push({
      material,
      kind,
    });
    options.onClassificationProgress?.({
      completed: classified.length,
      file: material.file,
      kind,
      total: candidates.length,
      source: classificationSource,
    });
    if (
      classified.filter((item) => item.kind === "jianying").length >= filesPerKind.jianying
      && classified.filter((item) => item.kind === "juchuang").length >= filesPerKind.juchuang
    ) break;
  }

  return selectOwnershipProjectProofFiles(classified, filesPerKind);
}

export async function listLocalPosterImages(options: {
  root: string;
  resourceName: string;
  rootIsResourceDir?: boolean;
  includeAllMatches?: boolean;
}): Promise<LocalPosterImageFile[]> {
  const resourceDir = options.rootIsResourceDir ? options.root : playletDir(options.root, options.resourceName);
  const namedCandidates: LocalPosterImageFile[] = [];
  const directoryCandidates: LocalPosterImageFile[] = [];
  const seenFiles = new Set<string>();

  for (const dir of await recursiveDirs(resourceDir)) {
    const relativeDirectoryParts = path.relative(resourceDir, dir).split(path.sep);
    if (relativeDirectoryParts.some((part) =>
      part === dramaPosterOriginalImageDirectoryName || part === dramaPosterTextDirectoryName
    )) continue;
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && ownershipImageExtensions.has(path.extname(entry.name).toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    const namedMatches = entries.filter((entry) => /封面|海报/.test(entry.name));
    const fromFileName = namedMatches.length > 0;
    let selectedEntries = namedMatches;
    if (!fromFileName && /封面|海报/.test(path.basename(dir))) {
      for (const entry of entries) {
        const metadata = await sharp(path.join(dir, entry.name)).metadata().catch(() => undefined);
        if (metadata?.width && metadata?.height && metadata.height > metadata.width) {
          selectedEntries = [entry];
          break;
        }
      }
    }
    for (const entry of selectedEntries) {
      const file = path.join(dir, entry.name);
      const resolved = path.resolve(file).toLowerCase();
      if (seenFiles.has(resolved)) continue;
      const fileStat = await stat(file).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size <= 0) continue;
      const metadata = await sharp(file).metadata().catch(() => undefined);
      const swapsOrientation = [5, 6, 7, 8].includes(metadata?.orientation ?? 1);
      seenFiles.add(resolved);
      (fromFileName ? namedCandidates : directoryCandidates).push({
        name: entry.name,
        file,
        size: fileStat.size,
        width: swapsOrientation ? metadata?.height : metadata?.width,
        height: swapsOrientation ? metadata?.width : metadata?.height,
      });
    }
  }

  const sortCandidates = (files: LocalPosterImageFile[]) => files.sort((left, right) =>
    Number(!left.name.includes("海报")) - Number(!right.name.includes("海报"))
    || left.name.localeCompare(right.name, "zh-CN", { numeric: true })
    || left.file.localeCompare(right.file));
  const sortedNamedCandidates = sortCandidates(namedCandidates);
  const sortedDirectoryCandidates = sortCandidates(directoryCandidates);
  if (options.includeAllMatches) {
    return [...sortedNamedCandidates, ...sortedDirectoryCandidates];
  }
  const selected = sortedNamedCandidates[0] ?? sortedDirectoryCandidates[0];
  return selected ? [selected] : [];
}

export async function listLocalAiProductionProofFiles(options: {
  root: string;
  resourceName: string;
  rootIsResourceDir?: boolean;
}): Promise<LocalAiProductionProofFile[]> {
  const resourceDir = options.rootIsResourceDir ? options.root : playletDir(options.root, options.resourceName);
  const result: LocalAiProductionProofFile[] = [];
  const seenFiles = new Set<string>();

  for (const dir of await recursiveDirs(resourceDir)) {
    const directoryMatches = /ai制作证明/i.test(
      path.relative(resourceDir, dir).replace(/\s+/g, ""),
    );
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !aiProductionProofExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (!directoryMatches && !/ai制作证明/i.test(entry.name.replace(/\s+/g, ""))) continue;
      const file = path.join(dir, entry.name);
      const resolved = path.resolve(file).toLowerCase();
      if (seenFiles.has(resolved)) continue;
      const fileStat = await stat(file).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size <= 0) continue;
      seenFiles.add(resolved);
      result.push({ name: entry.name, file, size: fileStat.size });
    }
  }

  return result.sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN", { numeric: true })
    || left.file.localeCompare(right.file));
}

export async function standardizeAiProductionProofFilesToRoot(options: {
  files: LocalAiProductionProofFile[];
  targetRoot: string;
  resourceName: string;
  onLog?: (message: string) => void;
}) {
  const targetDir = path.join(playletDir(options.targetRoot, options.resourceName), "AI制作证明");
  await mkdir(targetDir, { recursive: true });
  const standardized: LocalAiProductionProofFile[] = [];
  for (const [position, source] of options.files.entries()) {
    const extension = path.extname(source.file).toLowerCase() || ".jpg";
    const target = path.join(targetDir, `${options.resourceName} - AI制作证明${position + 1}${extension}`);
    if (!sameResolvedPath(source.file, target)) await copyFile(source.file, target);
    const targetStat = await stat(target);
    standardized.push({ name: path.basename(target), file: target, size: targetStat.size });
  }
  options.onLog?.(`[video-assets] AI制作证明标准化完成：文件=${standardized.length} dir=${targetDir}`);
  return standardized;
}

export async function standardizePosterImagesToRoot(options: {
  files: LocalPosterImageFile[];
  metadataSourceFiles?: string[];
  targetRoot: string;
  resourceName: string;
  onLog?: (message: string) => void;
}) {
  const targetDir = path.join(playletDir(options.targetRoot, options.resourceName), "海报封面");
  const originalImageDir = path.join(targetDir, dramaPosterOriginalImageDirectoryName);
  const textDir = path.join(targetDir, dramaPosterTextDirectoryName);
  const sourceRoots = [...new Map([
    ...options.files.map((source) => source.file),
    ...(options.metadataSourceFiles ?? []),
  ].map((sourceFile) => {
    const parent = path.dirname(sourceFile);
    return [path.resolve(parent).toLowerCase(), parent] as const;
  })).values()];
  const snapshotFiles = async (extensions: Set<string>, preferredSubdir: string) => {
    const snapshots: Array<{
      buffer: Buffer;
      originalName: string;
      originalRelativePath: string;
    }> = [];
    const seen = new Set<string>();
    for (const sourceRoot of sourceRoots) {
      const preferredRoot = path.join(sourceRoot, preferredSubdir);
      const scanRoot = await pathExists(preferredRoot) ? preferredRoot : sourceRoot;
      for (const dir of await recursiveDirs(scanRoot)) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
          const file = path.join(dir, entry.name);
          const key = path.resolve(file).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          snapshots.push({
            buffer: await readFile(file),
            originalName: entry.name,
            originalRelativePath: path.relative(scanRoot, file),
          });
        }
      }
    }
    return snapshots;
  };
  // The downloaded cover directory often also carries actor portraits and a TXT
  // synopsis. Snapshot them before replacing the directory with standardized covers.
  const [originalImages, textFiles] = await Promise.all([
    snapshotFiles(ownershipImageExtensions, dramaPosterOriginalImageDirectoryName),
    snapshotFiles(new Set([".txt", ".md", ".doc", ".docx", ".rtf"]), dramaPosterTextDirectoryName),
  ]);
  const sources = await Promise.all(options.files.map(async (source) => ({
    source,
    buffer: await readFile(source.file),
  })));
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  const standardized: LocalPosterImageFile[] = [];
  for (const [{ source, buffer }, index] of sources.map((item, index) => [item, index] as const)) {
    const extension = path.extname(source.file).toLowerCase() || ".jpg";
    const suffix = index === 0 ? "" : String(index + 1);
    const target = path.join(targetDir, `${options.resourceName} - 海报${suffix}${extension}`);
    await writeFile(target, buffer);
    const targetStat = await stat(target);
    standardized.push({
      name: path.basename(target),
      file: target,
      size: targetStat.size,
      width: source.width,
      height: source.height,
    });
  }
  const writeSnapshots = async (
    targetRoot: string,
    snapshots: Array<{ buffer: Buffer; originalName: string; originalRelativePath: string }>,
  ) => {
    await mkdir(targetRoot, { recursive: true });
    const usedNames = new Set<string>();
    const written: Array<{ originalName: string; originalRelativePath: string; localFile: string }> = [];
    for (const snapshot of snapshots) {
      const parsed = path.parse(snapshot.originalName);
      let fileName = snapshot.originalName;
      let suffix = 2;
      while (usedNames.has(fileName.toLowerCase())) {
        fileName = `${parsed.name}-${suffix}${parsed.ext}`;
        suffix += 1;
      }
      usedNames.add(fileName.toLowerCase());
      const target = path.join(targetRoot, fileName);
      await writeFile(target, snapshot.buffer);
      written.push({
        originalName: snapshot.originalName,
        originalRelativePath: snapshot.originalRelativePath,
        localFile: path.relative(targetDir, target),
      });
    }
    return written;
  };
  const [writtenImages, writtenTexts] = await Promise.all([
    writeSnapshots(originalImageDir, originalImages),
    writeSnapshots(textDir, textFiles),
  ]);
  await writeFile(
    path.join(targetDir, dramaPosterSourceManifestFileName),
    JSON.stringify({ images: writtenImages, texts: writtenTexts }, null, 2),
    "utf8",
  );
  options.onLog?.(
    `[video-assets] 海报封面标准化完成：封面=${standardized.length} `
      + `原始图片=${writtenImages.length} 文本=${writtenTexts.length} dir=${targetDir}`,
  );
  return standardized;
}

export function hasRequiredOwnershipMaterials(
  materials: LocalOwnershipMaterialSet,
  requirements: OwnershipMaterialRequirements = {},
) {
  if (materials.length < Math.max(0, requirements.minimumImages ?? 0)) return false;
  const requiredJianyingImages = Math.max(0, requirements.minimumJianyingImages ?? 0);
  if (requiredJianyingImages === 0) return true;
  return materials.filter((material) => (
    classifyOwnershipProjectProofName(`${material.file}/${material.name}`) === "jianying"
  )).length >= requiredJianyingImages;
}

export function selectRequiredOwnershipMaterials(
  materials: LocalOwnershipMaterialSet,
  requirements: OwnershipMaterialRequirements,
) {
  return materials.slice(0, Math.max(0, requirements.minimumImages ?? 0));
}

export async function standardizeOwnershipMaterialsToRoot(options: {
  materials: LocalOwnershipMaterialSet;
  requirements: OwnershipMaterialRequirements;
  targetRoot: string;
  resourceName: string;
  onLog?: (message: string) => void;
}) {
  const selected = options.materials;
  const targetDir = path.join(playletDir(options.targetRoot, options.resourceName), "权属文件");
  await mkdir(targetDir, { recursive: true });
  const standardized: LocalOwnershipMaterialSet = [];
  const proofKindPositions = { jianying: 0, juchuang: 0 };

  for (const [position, material] of selected.entries()) {
    const extension = path.extname(material.file).toLowerCase() || ".jpg";
    // Classify before flattening into 权属文件 so labels on any ancestor
    // directory (for example 剪映工程图/截图) survive standardization.
    const proofKind = classifyOwnershipProjectProofName(`${material.file}/${material.name}`);
    const proofLabel = proofKind === "jianying"
      ? "剪映"
      : proofKind === "juchuang"
        ? "剧创"
        : "权属工程文件";
    const proofPosition = proofKind === "jianying" || proofKind === "juchuang"
      ? ++proofKindPositions[proofKind]
      : position + 1;
    const target = path.join(
      targetDir,
      `${options.resourceName} - ${proofLabel}${proofPosition}${extension}`,
    );
    if (!sameResolvedPath(material.file, target)) await copyFile(material.file, target);
    const targetStat = await stat(target);
    standardized.push({ ...material, index: position + 1, name: path.basename(target), file: target, size: targetStat.size });
  }

  options.onLog?.(
    `[video-assets] 权属材料标准化完成：图片=${standardized.length} dir=${targetDir}`,
  );
  return standardized;
}

export async function composeOwnershipMaterials(options: {
  files: LocalOwnershipMaterialFile[];
  outputDir: string;
  resourceName: string;
  onLog?: (message: string) => void;
}) {
  if (options.files.length === 0) throw new Error("[production-proof-invalid] 没有可合成的权属图片。");
  const labelHeight = 56;
  const padding = 12;
  const maxHeight = 1400;
  const prepared = await Promise.all(options.files.map(async (file) => {
    const image = sharp(file.file, { failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new Error(`[production-proof-invalid] 无法读取权属图片尺寸: ${file.file}`);
    const buffer = await image
      .resize({ height: maxHeight - labelHeight - padding * 2, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const resized = await sharp(buffer).metadata();
    return { file, buffer, width: resized.width ?? metadata.width, height: resized.height ?? metadata.height };
  }));
  const canvasWidth = prepared.reduce((sum, item) => sum + item.width + padding * 2, 0);
  const canvasHeight = Math.max(...prepared.map((item) => item.height + labelHeight + padding * 2));
  const composites = prepared.map((item, index) => {
    const left = prepared.slice(0, index).reduce((sum, previous) => sum + previous.width + padding * 2, 0);
    const top = 0;
    const caption = Buffer.from(
      `<svg width="${item.width + padding * 2}" height="${labelHeight}"><style>text{font-family:Microsoft YaHei,Arial;font-size:24px;fill:#222}</style><text x="${padding}" y="38">权属${item.file.index ?? index + 1} · ${escapeXml(item.file.name)}</text></svg>`,
    );
    return [
      { input: caption, left, top },
      { input: item.buffer, left: left + padding, top: top + labelHeight + padding },
    ];
  }).flat();
  const outputBase = path.join(options.outputDir, `${safeEpisodeFileBaseName(options.resourceName)}-权属工程文件合成`);
  await mkdir(options.outputDir, { recursive: true });
  const pngPath = `${outputBase}.png`;
  await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: "white" } })
    .composite(composites)
    .png()
    .toFile(pngPath);
  const pngStat = await stat(pngPath);
  if (pngStat.size <= 9_500_000) return pngPath;
  const jpgPath = `${outputBase}.jpg`;
  await sharp(pngPath).jpeg({ quality: 82, progressive: true }).toFile(jpgPath);
  await rm(pngPath, { force: true });
  options.onLog?.(`[video-assets] 权属合成图超过10MB，已压缩为JPEG：${jpgPath}`);
  return jpgPath;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char] ?? char);
}

export async function composeOwnershipMaterialsIntoTwo(options: {
  files: LocalOwnershipMaterialFile[];
  outputDir: string;
  resourceName: string;
}) {
  if (options.files.length === 0) throw new Error("[production-proof-invalid] 没有可合成的权属图片。");
  const splitAt = Math.ceil(options.files.length / 2);
  const groups = [options.files.slice(0, splitAt), options.files.slice(splitAt)].filter((group) => group.length > 0);
  await mkdir(options.outputDir, { recursive: true });
  return Promise.all(groups.map(async (group, groupIndex) => {
    const source = await Promise.all(group.map(async (file) => {
      const metadata = await sharp(file.file, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height) throw new Error(`[production-proof-invalid] 无法读取权属图片尺寸: ${file.file}`);
      return { file, width: metadata.width, height: metadata.height };
    }));
    const width = Math.min(2400, ...source.map((item) => item.width));
    const prepared = await Promise.all(source.map(async (item) => {
      const buffer = await sharp(item.file.file).resize({ width, withoutEnlargement: true }).png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      return { buffer, width: metadata.width ?? width, height: metadata.height ?? item.height };
    }));
    const canvasWidth = Math.max(...prepared.map((item) => item.width));
    const canvasHeight = prepared.reduce((sum, item) => sum + item.height, 0);
    let top = 0;
    const composites = prepared.map((item) => {
      const result = { input: item.buffer, left: 0, top };
      top += item.height;
      return result;
    });
    const output = path.join(options.outputDir, `${safeEpisodeFileBaseName(options.resourceName)}-权属工程文件合成${groupIndex + 1}.jpg`);
    await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: "white" } })
      .composite(composites).jpeg({ quality: 92, progressive: true }).toFile(output);
    return output;
  }));
}

export async function composeOwnershipMaterialsIntoOne(options: {
  files: LocalOwnershipMaterialFile[];
  outputDir: string;
  resourceName: string;
}) {
  if (options.files.length === 0) {
    throw new Error("[production-proof-invalid] 没有可合成的权属图片。");
  }
  const source = await Promise.all(options.files.map(async (file) => {
    const metadata = await sharp(file.file, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`[production-proof-invalid] 无法读取权属图片尺寸: ${file.file}`);
    }
    return { file, width: metadata.width, height: metadata.height };
  }));
  const initialWidth = Math.min(2400, ...source.map((item) => item.width));

  const prepareAtWidth = (width: number) => Promise.all(source.map(async (item) => {
    const buffer = await sharp(item.file.file)
      .resize({ width, withoutEnlargement: true })
      .png()
      .toBuffer();
    const metadata = await sharp(buffer).metadata();
    return {
      buffer,
      width: metadata.width ?? width,
      height: metadata.height ?? item.height,
    };
  }));

  let prepared = await prepareAtWidth(initialWidth);
  const initialHeight = prepared.reduce((sum, item) => sum + item.height, 0);
  if (initialHeight > 30_000) {
    const reducedWidth = Math.max(1, Math.floor(initialWidth * 30_000 / initialHeight));
    prepared = await prepareAtWidth(reducedWidth);
  }

  const canvasWidth = Math.max(...prepared.map((item) => item.width));
  const canvasHeight = prepared.reduce((sum, item) => sum + item.height, 0);
  let top = 0;
  const composites = prepared.map((item) => {
    const result = { input: item.buffer, left: 0, top };
    top += item.height;
    return result;
  });

  await mkdir(options.outputDir, { recursive: true });
  const output = path.join(
    options.outputDir,
    `${safeEpisodeFileBaseName(options.resourceName)}-权属工程文件合成1.jpg`,
  );
  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: "white",
    },
  })
    .composite(composites)
    .jpeg({ quality: 92, progressive: true })
    .toFile(output);
  return output;
}

function sameResolvedPath(left: string, right: string) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export async function listLocalEpisodeFiles(options: {
  root: string;
  resourceName: string;
  allowArbitraryDir?: boolean;
  selectedEpisodeFiles?: SelectedEpisodeFileIdentity[];
}) {
  const scanDirs = options.allowArbitraryDir
    ? await recursiveLocalEpisodeScanDirs(options.root, options.resourceName)
    : localEpisodeScanDirs(options.root, options.resourceName);
  const candidates: Array<{ dir: string; files: LocalEpisodeFile[] }> = [];

  for (const scanDir of scanDirs) {
    candidates.push({
      dir: scanDir,
      files: await listDirectLocalEpisodeFiles(
        scanDir,
        options.resourceName,
        options.selectedEpisodeFiles,
      ),
    });
  }

  const best = candidates.sort(
    (left, right) => right.files.length - left.files.length || left.dir.localeCompare(right.dir),
  )[0];
  return (best?.files ?? []).sort((left, right) => left.index - right.index);
}

export function isCompleteEpisodeFileSet(
  files: Array<{ index: number; file: string; size?: number }>,
  episodeCount: number,
) {
  const normalizedEpisodeCount = Number(episodeCount);
  if (!Number.isInteger(normalizedEpisodeCount) || normalizedEpisodeCount <= 0) {
    return false;
  }

  const expectedIndexes = Array.from({ length: normalizedEpisodeCount }, (_, index) => index + 1);
  if (files.length !== expectedIndexes.length) return false;
  const actualIndexSet = new Set(files.map((file) => file.index));
  return expectedIndexes.every((index) => actualIndexSet.has(index));
}

export async function hasCompleteLocalEpisodeVideos(options: {
  root: string;
  resourceName: string;
  episodeCount: number;
}) {
  if (!(await pathExists(playletDir(options.root, options.resourceName)))) {
    return false;
  }

  const files = await listLocalEpisodeFiles({
    root: options.root,
    resourceName: options.resourceName,
  });
  return isCompleteEpisodeFileSet(files, options.episodeCount);
}

export function fileSetSignature(files: Array<{ index: number; size?: number }>) {
  return files.map((file) => `${file.index}:${file.size ?? 0}`).join("|");
}

export function episodeFileSummary(files: Array<{ index: number }>) {
  const indexes = [...new Set(files.map((file) => file.index))].sort((left, right) => left - right);
  return {
    count: indexes.length,
    min: indexes[0],
    max: indexes[indexes.length - 1],
  };
}

export function standardEpisodeFileName(resourceName: string, index: number, extension = ".mp4") {
  const normalizedExtension = episodeVideoExtensions.has(extension.toLowerCase())
    ? extension.toLowerCase()
    : ".mp4";
  return `${resourceName} - 第${index}集${normalizedExtension}`;
}

function localEpisodeSourceDir(files: LocalEpisodeFile[]) {
  const dirs = [...new Set(files.map((file) => path.dirname(file.file)))];
  return dirs.length === 1 ? dirs[0] : undefined;
}

async function moveOrCopyFile(sourceFile: string, targetFile: string) {
  await removePathWithRetry(targetFile, { force: true });
  try {
    await retryFileSystemOperation(() => rename(sourceFile, targetFile));
    return "move" as const;
  } catch {
    await retryFileSystemOperation(() => copyFile(sourceFile, targetFile));
    return "copy" as const;
  }
}

export async function standardizeEpisodeFilesToRoot(options: {
  files: LocalEpisodeFile[];
  targetRoot: string;
  resourceName: string;
  onLog?: (message: string) => void;
}) {
  const targetDir = playletDir(options.targetRoot, options.resourceName);
  const sourceDir = localEpisodeSourceDir(options.files);
  const sourceLabel = sourceDir ?? "多个目录";
  let workingFiles = [...options.files].sort(
    (left, right) => left.index - right.index || left.file.localeCompare(right.file),
  );
  let directoryRenamed = false;
  let targetExists = await pathExists(targetDir);

  options.onLog?.(`[video-assets] 标准化剧集目录和文件名：${sourceLabel} -> ${targetDir}`);

  if (sourceDir) {
    const sourceResolved = path.resolve(sourceDir);
    const targetResolved = path.resolve(targetDir);
    if (sourceResolved.toLowerCase() !== targetResolved.toLowerCase() && !targetExists) {
      await mkdir(path.dirname(targetDir), { recursive: true });
      try {
        await rename(sourceDir, targetDir);
        directoryRenamed = true;
        targetExists = true;
        workingFiles = workingFiles.map((file) => ({
          ...file,
          file: path.join(targetDir, path.basename(file.file)),
        }));
      } catch (error) {
        options.onLog?.(
          `[video-assets] 标准化目录重命名失败，回退逐文件移动：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (!targetExists) {
    await mkdir(targetDir, { recursive: true });
  }

  const standardPaths = new Set<string>();
  let movedCount = 0;
  let copiedCount = 0;

  for (const file of workingFiles) {
    const targetFile = path.join(
      targetDir,
      standardEpisodeFileName(options.resourceName, file.index, path.extname(file.file)),
    );
    standardPaths.add(path.resolve(targetFile).toLowerCase());

    if (path.resolve(file.file).toLowerCase() === path.resolve(targetFile).toLowerCase()) continue;
    const operation = await moveOrCopyFile(file.file, targetFile);
    if (operation === "move") movedCount += 1;
    else copiedCount += 1;
  }

  const existingEntries = await readdir(targetDir, { withFileTypes: true }).catch(() => []);
  for (const entry of existingEntries) {
    if (!entry.isFile() || !isSupportedEpisodeVideoFileName(entry.name)) continue;

    const entryPath = path.join(targetDir, entry.name);
    if (standardPaths.has(path.resolve(entryPath).toLowerCase())) continue;
    await rm(entryPath, { force: true });
  }

  options.onLog?.(
    `[video-assets] 标准化剧集完成：目录重命名=${directoryRenamed ? "是" : "否"} 移动=${movedCount} 复制=${copiedCount}`,
  );

  return targetDir;
}

export async function findLocalEpisodeVideos(options: {
  localEpisodeVideoRoot: string;
  resourceName: string;
}): Promise<LocalEpisodeVideo[]> {
  const playletVideoDir = playletDir(options.localEpisodeVideoRoot, options.resourceName);
  if (!(await pathExists(playletVideoDir))) {
    throw new Error(`[local-video-invalid] 剧集视频目录不存在: ${playletVideoDir}`);
  }

  return (
    await listLocalEpisodeFiles({
      root: options.localEpisodeVideoRoot,
      resourceName: options.resourceName,
    })
  ).map((file) => ({
    index: file.index,
    title: `第${file.index}集`,
    file: file.file,
  }));
}

export async function validateLocalEpisodeVideos(options: {
  localEpisodeVideoRoot: string;
  resourceName: string;
  episodeCount: number;
}) {
  const episodes = await findLocalEpisodeVideos(options);
  const duplicateIndexes = episodes
    .filter((episode, index) => index > 0 && episode.index === episodes[index - 1].index)
    .map((episode) => episode.index);
  if (duplicateIndexes.length > 0) {
    throw new Error(
      `[local-video-invalid] 存在重复集数: ${[...new Set(duplicateIndexes)].join(", ")}`,
    );
  }

  const expectedIndexes = Array.from({ length: options.episodeCount }, (_, index) => index + 1);
  const actualIndexes = episodes.map((episode) => episode.index);
  if (
    actualIndexes.length !== expectedIndexes.length ||
    actualIndexes.some((value, index) => value !== expectedIndexes[index])
  ) {
    throw new Error(
      `[local-video-invalid] 剧集文件应按文件名匹配第1集至第${options.episodeCount}集: ` +
        `originalTitle=${options.resourceName} actual=[${actualIndexes.join(", ")}] dir=${playletDir(
          options.localEpisodeVideoRoot,
          options.resourceName,
        )}`,
    );
  }
}

export type EpisodeVideoDuration = {
  index: number;
  file: string;
  durationSeconds: number;
};

export function findEpisodeMinimumDurationViolations(
  episodes: EpisodeVideoDuration[],
  minimumDurationSeconds: number,
) {
  return episodes.filter((episode) => episode.durationSeconds <= minimumDurationSeconds);
}

const episodeDurationCache = new Map<string, number>();

async function cachedVideoDurationSeconds(
  file: LocalEpisodeFile,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const cacheKey = `${path.resolve(file.file).toLowerCase()}#${file.size}#${file.modifiedAtMs}`;
  const cached = episodeDurationCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const durationSeconds = await readVideoDurationSeconds(file.file, controller.signal);
    if (episodeDurationCache.size >= 2_048) {
      const oldest = episodeDurationCache.keys().next().value;
      if (oldest) episodeDurationCache.delete(oldest);
    }
    episodeDurationCache.set(cacheKey, durationSeconds);
    return durationSeconds;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("视频时长校验已终止。"), { name: "AbortError" });
    }
    if (controller.signal.aborted) {
      throw Object.assign(
        new Error(`[episode-duration-invalid] 读取视频时长超时: ${file.file}`),
        { cause: error },
      );
    }
    throw Object.assign(new Error(
      `[episode-duration-invalid] 无法读取视频时长: ${file.file}; ${
        error instanceof Error ? error.message : String(error)
      }`,
    ), { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function validateLocalEpisodeMinimumDuration(options: {
  localEpisodeVideoRoot: string;
  resourceName: string;
  episodeCount: number;
  minimumDurationSeconds?: number;
  concurrency?: number;
  perFileTimeoutMs?: number;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
}) {
  const minimumDurationSeconds = Number(options.minimumDurationSeconds);
  if (!Number.isFinite(minimumDurationSeconds) || minimumDurationSeconds <= 0) return [];

  await validateLocalEpisodeVideos(options);
  const files = await listLocalEpisodeFiles({
    root: options.localEpisodeVideoRoot,
    resourceName: options.resourceName,
  });
  const durations: EpisodeVideoDuration[] = [];
  const concurrency = Math.min(files.length, Math.max(1, Math.floor(options.concurrency ?? 4)));
  const perFileTimeoutMs = Math.max(1_000, options.perFileTimeoutMs ?? 15_000);
  let cursor = 0;

  options.onLog?.(
    `[episode-duration] 开始校验${files.length}集，要求每集时长大于${minimumDurationSeconds}秒`,
  );
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < files.length) {
      options.signal?.throwIfAborted();
      const position = cursor;
      cursor += 1;
      const file = files[position];
      durations[position] = {
        index: file.index,
        file: file.file,
        durationSeconds: await cachedVideoDurationSeconds(file, perFileTimeoutMs, options.signal),
      };
    }
  }));

  const violations = findEpisodeMinimumDurationViolations(durations, minimumDurationSeconds);
  if (violations.length > 0) {
    const visible = violations.slice(0, 20).map((episode) => (
      `第${episode.index}集=${episode.durationSeconds.toFixed(2)}秒(${path.basename(episode.file)})`
    ));
    const remaining = violations.length > visible.length
      ? `；另有${violations.length - visible.length}集不符合要求`
      : "";
    throw new Error(
      `[episode-duration-invalid] 存在时长不超过${minimumDurationSeconds}秒的剧集，共${violations.length}集：`
        + `${visible.join("；")}${remaining}`,
    );
  }

  options.onLog?.(
    `[episode-duration] 校验通过：${durations.length}集时长均大于${minimumDurationSeconds}秒`,
  );
  return durations;
}

async function createEpisodeUploadHardLink(source: string, target: string) {
  try {
    await link(source, target);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EXDEV") {
      throw Object.assign(
        new Error(
          `[local-video-invalid] 无法为剧集视频创建硬链接，源文件和临时上传目录不在同一磁盘分区: ${source} -> ${target}; cause=${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
        { cause: error },
      );
    }
    throw error;
  }
}

export async function prepareEpisodeUploadFiles(options: {
  localEpisodeVideoRoot: string;
  resourceName: string;
  uploadRootDir: string;
  uploadBaseName?: string;
  episodes?: LocalEpisodeVideo[];
}): Promise<PreparedEpisodeUploadFiles> {
  await mkdir(options.uploadRootDir, { recursive: true });
  let uploadDir = path.join(options.uploadRootDir, `episode-upload-${Date.now()}`);
  for (let suffix = 0; ; suffix += 1) {
    try {
      await mkdir(uploadDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      uploadDir = path.join(options.uploadRootDir, `episode-upload-${Date.now() + suffix + 1}`);
    }
  }

  try {
    await createRuntimeArtifactLease(uploadDir);
    const playletName = safeEpisodeFileBaseName(options.uploadBaseName ?? options.resourceName);
    const files: string[] = [];
    const sourceFiles: string[] = [];
    for (const episode of options.episodes ?? await findLocalEpisodeVideos(options)) {
      const extension = path.extname(episode.file).toLowerCase() || ".mp4";
      const target = path.join(uploadDir, `${playletName}-第${episode.index}集${extension}`);
      await createEpisodeUploadHardLink(episode.file, target);
      files.push(target);
      sourceFiles.push(episode.file);
    }

    return { uploadDir, files, sourceFiles };
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupEpisodeUploadFiles(prepared: PreparedEpisodeUploadFiles) {
  await rm(prepared.uploadDir, { recursive: true, force: true }).catch(() => undefined);
}

export async function collectEpisodeDirectorySummaries(options: {
  root: string;
  resourceName: string;
  recursive?: boolean;
}): Promise<EpisodeDirectorySummary[]> {
  const scanDirs = options.recursive
    ? await recursiveLocalEpisodeScanDirs(options.root, options.resourceName)
    : localEpisodeScanDirs(options.root, options.resourceName);
  const summaries: EpisodeDirectorySummary[] = [];

  for (const scanDir of scanDirs) {
    const entries = await readdir(scanDir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) continue;

    const matchedMp4: string[] = [];
    const unmatchedMp4: string[] = [];
    let fileCount = 0;
    let directoryCount = 0;

    for (const entry of entries) {
      const entryPath = path.join(scanDir, entry.name);
      if (entry.isDirectory()) {
        directoryCount += 1;
        continue;
      }
      if (!entry.isFile()) continue;

      fileCount += 1;
      const fileStat = await stat(entryPath).catch(() => undefined);
      const size = fileStat?.isFile() ? fileStat.size : undefined;
      if (!isSupportedEpisodeVideoFileName(entry.name)) continue;

      const episodeIndex = matchLocalEpisodeIndex(entry.name, options.resourceName);
      if (episodeIndex === undefined) {
        unmatchedMp4.push(entry.name);
      } else {
        matchedMp4.push(
          `${episodeIndex}:${entry.name}${size === undefined ? "" : ` size=${size}`}`,
        );
      }
    }

    if (fileCount > 0 || directoryCount > 0 || matchedMp4.length > 0 || unmatchedMp4.length > 0) {
      summaries.push({ dir: scanDir, fileCount, directoryCount, matchedMp4, unmatchedMp4 });
    }
  }

  return summaries.sort(
    (left, right) =>
      right.matchedMp4.length - left.matchedMp4.length || left.dir.localeCompare(right.dir),
  );
}
