import { existsSync } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import ffmpegPathImport from "ffmpeg-static";
import sharp from "sharp";

const ffmpegPath = ffmpegPathImport as unknown as string | null;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".m4v"]);
const EPISODE_PATTERN = /第\s*(\d+)\s*集/i;
const WORKFLOW_MANIFEST = "dramabridge.json";
const WORKFLOW_VERSION = 8;

export type DramaEpisode = {
  episode: number;
  file: string;
  name: string;
};

export type PreparedEpisodeDraft = {
  dramaName: string;
  episode: number;
  presetName: string;
  presetPath: string;
  sourceFile: string;
  draftName: string;
  draftPath: string;
  segmentCount: number;
  segmentFiles: string[];
  segmentDurations: number[];
  previewTimelineTime?: number;
  timelineDuration?: number;
  trackWrittenAt?: string;
  mediaLibraryWrittenAt?: string;
  draftIdentitySynchronizedAt?: string;
  missingMediaCleanedAt?: string;
};

function resolveFfmpegPath() {
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    ffmpegPath?.replace("app.asar", "app.asar.unpacked"),
    path.resolve(process.cwd(), ".cache", "ffmpeg-static", executableName),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? executableName;
}

async function exists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runMediaCommand(
  executable: string,
  args: string[],
  timeout = 10 * 60_000,
) {
  return execa(executable, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function mediaDuration(file: string) {
  const executable = resolveFfmpegPath();
  const { stderr } = await runMediaCommand(executable, [
    "-hide_banner",
    "-i",
    file,
    "-t",
    "0",
    "-f",
    "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : Number.NaN;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`无法读取视频时长：${path.basename(file)}`);
  }
  return duration;
}

export async function findDramaEpisodes(dramaDirectory: string, limit = 4) {
  const normalizedDirectory = path.resolve(dramaDirectory);
  const entries = await readdir(normalizedDirectory, { withFileTypes: true });
  const episodes = entries
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .flatMap((entry): DramaEpisode[] => {
      const match = entry.name.match(EPISODE_PATTERN);
      if (!match) return [];
      return [{
        episode: Number(match[1]),
        file: path.join(normalizedDirectory, entry.name),
        name: entry.name,
      }];
    })
    .sort((left, right) => left.episode - right.episode);

  const uniqueEpisodes = new Map<number, DramaEpisode>();
  for (const episode of episodes) {
    if (!uniqueEpisodes.has(episode.episode)) uniqueEpisodes.set(episode.episode, episode);
  }

  const result = [...uniqueEpisodes.values()].slice(0, limit);
  if (result.length < limit) {
    throw new Error(`剧目目录只识别到 ${result.length} 集，至少需要 ${limit} 集`);
  }
  return result;
}

async function detectSceneTimes(file: string, duration: number) {
  const executable = resolveFfmpegPath();
  const { stderr } = await runMediaCommand(executable, [
    "-hide_banner",
    "-i",
    file,
    "-vf",
    "select='gt(scene,0.28)',showinfo",
    "-an",
    "-f",
    "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);
  const detected = [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((time) => Number.isFinite(time) && time > 0.5 && time < duration - 0.5);
  return [...new Set([0, ...detected, duration])].sort((left, right) => left - right);
}

function selectSegmentStarts(boundaries: number[], duration: number, count: number) {
  const scenes = boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1] ?? duration,
  })).filter((scene) => scene.end - scene.start >= 0.8);

  if (scenes.length >= count) {
    return Array.from({ length: count }, (_, index) => {
      const sceneIndex = Math.min(
        scenes.length - 1,
        Math.round(index * (scenes.length - 1) / Math.max(1, count - 1)),
      );
      return scenes[sceneIndex]!.start;
    });
  }

  return Array.from({ length: count }, (_, index) => (
    Math.max(0, index * Math.max(0, duration - 1) / Math.max(1, count - 1))
  ));
}

async function encodeSlot(
  sourceFile: string,
  start: number,
  duration: number,
  outputFile: string,
) {
  const executable = resolveFfmpegPath();
  await runMediaCommand(executable, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    start.toFixed(3),
    "-i",
    sourceFile,
    "-t",
    duration.toFixed(3),
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30,format=yuv420p",
    "-af",
    `apad=whole_dur=${duration.toFixed(3)}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-y",
    outputFile,
  ]);
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]!, index);
    }
  }));
}

export async function prepareEpisodeDraft(input: {
  dramaDirectory: string;
  episode: DramaEpisode;
  presetPath: string;
  draftRoot: string;
  screenshotRoot?: string;
}) {
  const dramaName = path.basename(path.resolve(input.dramaDirectory));
  const draftName = `${dramaName}-第${input.episode.episode}集`;
  const draftRoot = path.resolve(input.draftRoot);
  const draftPath = path.join(draftRoot, draftName);
  if (path.dirname(draftPath) !== draftRoot) throw new Error("草稿目标路径无效");
  if (await exists(draftPath)) throw new Error(`草稿已存在：${draftName}`);

  const presetPath = path.resolve(input.presetPath);
  const presetSegmentsDirectory = path.join(presetPath, "video_segments");
  const presetNumber = Number(/^新预设(\d+)$/.exec(path.basename(presetPath))?.[1]);
  const slotFiles = (await readdir(presetSegmentsDirectory).catch(() => []))
    .map((name) => ({ name, match: /^(\d+)-(\d+)\.mp4$/i.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => (
      entry.match !== null
      && (!Number.isInteger(presetNumber) || Number(entry.match[1]) === presetNumber)
    ))
    .sort((left, right) => Number(left.match[2]) - Number(right.match[2]))
    .map((entry) => entry.name);
  if (!slotFiles.length) {
    throw new Error(`${path.basename(presetPath)} 中没有视频片段槽位`);
  }

  const [sourceDuration, ...slotDurations] = await Promise.all([
    mediaDuration(input.episode.file),
    ...slotFiles.map((name) => mediaDuration(path.join(presetSegmentsDirectory, name))),
  ]);
  const boundaries = await detectSceneTimes(input.episode.file, sourceDuration);
  const starts = selectSegmentStarts(boundaries, sourceDuration, slotFiles.length);

  await cp(presetPath, draftPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  try {
    // Keep every file referenced by the source preset untouched. Generated clips
    // live only in the copied episode draft and are linked into its video track.
    const targetSegmentsDirectory = path.join(draftPath, "DramaBridgeSegments");
    await mkdir(targetSegmentsDirectory, { recursive: true });
    const segmentFiles = slotFiles.map((_, index) => path.join(
      targetSegmentsDirectory,
      `${draftName}-片段${String(index + 1).padStart(2, "0")}.mp4`,
    ));
    await mapWithConcurrency(slotFiles, 2, async (_name, index) => {
      const slotDuration = slotDurations[index]!;
      const safeStart = Math.min(starts[index]!, Math.max(0, sourceDuration - slotDuration));
      await encodeSlot(
        input.episode.file,
        safeStart,
        slotDuration,
        segmentFiles[index]!,
      );
    });

    const result = {
      dramaName,
      episode: input.episode.episode,
      presetName: path.basename(presetPath),
      presetPath,
      sourceFile: input.episode.file,
      draftName,
      draftPath,
      segmentCount: slotFiles.length,
      segmentFiles,
      segmentDurations: slotDurations,
    } satisfies PreparedEpisodeDraft;
    await writeFile(
      path.join(draftPath, WORKFLOW_MANIFEST),
      JSON.stringify({ version: WORKFLOW_VERSION, ...result }, null, 2),
      "utf8",
    );
    return result;
  } catch (error) {
    await rm(draftPath, { recursive: true, force: true });
    throw error;
  }
}

export async function readPreparedEpisodeDraft(draftPath: string) {
  const manifestPath = path.join(path.resolve(draftPath), WORKFLOW_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PreparedEpisodeDraft & {
    version?: number;
  };
  const manifestVersion = manifest.version ?? 0;
  const supportedVersion = [WORKFLOW_VERSION, 7, 6, 5, 4, 3, 2, 1].includes(manifestVersion);
  if (!supportedVersion || !Array.isArray(manifest.segmentFiles)) {
    throw new Error("草稿自动化数据版本不匹配，请重新生成");
  }
  await Promise.all(manifest.segmentFiles.map(async (file) => {
    if (!(await exists(file))) throw new Error(`分段视频不存在：${path.basename(file)}`);
  }));
  return {
    ...manifest,
    segmentDurations: Array.isArray(manifest.segmentDurations) ? manifest.segmentDurations : [],
    // Workflow v4 marked the media library as written even though no material
    // index had been generated. v5 used the real UI import and v6 writes the
    // same index directly, so only v4 and older must be migrated.
    mediaLibraryWrittenAt: manifestVersion >= 5
      ? manifest.mediaLibraryWrittenAt
      : undefined,
    draftIdentitySynchronizedAt: manifestVersion >= 7
      ? manifest.draftIdentitySynchronizedAt
      : undefined,
    missingMediaCleanedAt: manifestVersion >= 8
      ? manifest.missingMediaCleanedAt
      : undefined,
  };
}

export async function markPreparedEpisodeTrackWritten(
  draftPath: string,
  previewTimelineTime?: number | null,
  timelineDuration?: number,
) {
  const manifest = await readPreparedEpisodeDraft(draftPath);
  const updated = {
    ...manifest,
    version: WORKFLOW_VERSION,
    trackWrittenAt: new Date().toISOString(),
    draftIdentitySynchronizedAt: new Date().toISOString(),
    missingMediaCleanedAt: new Date().toISOString(),
    previewTimelineTime: previewTimelineTime ?? manifest.previewTimelineTime,
    timelineDuration: timelineDuration ?? manifest.timelineDuration,
  };
  await writeFile(
    path.join(path.resolve(draftPath), WORKFLOW_MANIFEST),
    JSON.stringify(updated, null, 2),
    "utf8",
  );
  return updated;
}

export async function markPreparedEpisodeMediaLibraryWritten(draftPath: string) {
  const manifest = await readPreparedEpisodeDraft(draftPath);
  const updated = {
    ...manifest,
    version: WORKFLOW_VERSION,
    mediaLibraryWrittenAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(path.resolve(draftPath), WORKFLOW_MANIFEST),
    JSON.stringify(updated, null, 2),
    "utf8",
  );
  return updated;
}


export async function cropJianyingPreviewScreenshot(
  inputFile: string,
  outputFile: string,
  crop?: { left: number; top: number; width: number; height: number },
) {
  const metadata = await sharp(inputFile).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 800 || height < 500) throw new Error("剪映窗口截图尺寸异常");

  const left = Math.max(0, Math.round(crop?.left ?? width * 0.601));
  const top = Math.max(0, Math.round(crop?.top ?? height * 0.083));
  const cropWidth = Math.min(Math.round(crop?.width ?? height * 0.225), width - left);
  const cropHeight = Math.min(Math.round(crop?.height ?? cropWidth * 16 / 9), height - top);
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await sharp(inputFile)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toFile(outputFile);
  return path.resolve(outputFile);
}
