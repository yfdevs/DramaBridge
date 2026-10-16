import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import PQueue from "p-queue";

export type VideoSizePolicy = {
  maxFileBytes: number;
  targetFileBytes: number;
  audioBitrateKbps?: number;
  minimumVideoBitrateKbps?: number;
  targetVideoBitrateKbps?: number;
  preset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow";
  threadsPerJob?: number;
};

export type VideoTranscodeRequest = {
  inputFile: string;
  cacheRootDir: string;
  policy: VideoSizePolicy;
  replaceSource?: boolean;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
};

export type PreparedVideoFile = {
  sourceFile: string;
  file: string;
  originalSize: number;
  outputSize: number;
  transcoded: boolean;
  cacheKey: string;
};

export type VideoTranscodeQueueOptions = {
  concurrency?: number;
  timeoutMs?: number;
  onLog?: (message: string) => void;
};

export type VideoPlaybackSpeedRequest = {
  inputFile: string;
  speed: number;
  sourceDurationSeconds?: number;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
};

export type AdjustedVideoPlaybackSpeed = {
  file: string;
  speed: number;
  sourceDurationSeconds: number;
  outputDurationSeconds: number;
  outputVideoDurationSeconds: number;
  outputAudioDurationSeconds?: number;
};

export type VideoDimensions = {
  width: number;
  height: number;
};

export type VideoStreamMetadata = VideoDimensions & {
  durationSeconds: number;
  videoBitrateKbps: number;
  bitrateSource: "stream" | "estimated";
};

export type EnsureVideoMinimumDimensionsRequest = {
  inputFile: string;
  outputFile: string;
  minimumWidth: number;
  minimumHeight: number;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
};

export type ExtractRandomVideoFramesRequest = {
  inputFile: string;
  outputDir: string;
  count?: number;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  random?: () => number;
};

const defaultAudioBitrateKbps = 128;
const minimumVideoBitrateKbps = 100;
const durationPattern = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;
const progressTimePattern = /time=\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g;
const videoDimensionsPattern = /Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/u;
const videoStreamPattern = /^\s*Stream[^\r\n]*Video:[^\r\n]*$/gimu;
const streamBitratePattern = /\b(\d+(?:\.\d+)?)\s*kb\/s\b/iu;

function assertPolicy(policy: VideoSizePolicy) {
  if (!Number.isFinite(policy.maxFileBytes) || policy.maxFileBytes <= 0) {
    throw new Error("maxFileBytes must be a positive number.");
  }
  if (
    !Number.isFinite(policy.targetFileBytes)
    || policy.targetFileBytes <= 0
    || policy.targetFileBytes >= policy.maxFileBytes
  ) {
    throw new Error("targetFileBytes must be positive and lower than maxFileBytes.");
  }
}

export function resolveFfmpegExecutablePath() {
  const executablePath = ffmpegPath as unknown as string | null;
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    executablePath?.replace("app.asar", "app.asar.unpacked"),
    path.resolve(process.cwd(), ".cache", "ffmpeg-static", executableName),
  ].filter((value): value is string => Boolean(value));
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;
  if (executablePath && !path.isAbsolute(executablePath)) return executablePath;
  if (process.env.PATH) return executableName;
  throw new Error(
    `[video-transcode-failed] 找不到 FFmpeg 可执行文件: candidates=${candidates.join(",")}`,
  );
}

function secondsFromDurationMatch(match: RegExpExecArray) {
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function runFfmpeg(
  args: string[],
  options: {
    signal?: AbortSignal;
    acceptExitCode?: (code: number | null) => boolean;
    onStderr?: (text: string) => void;
  } = {},
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutablePath(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        reject(Object.assign(new Error("[video-transcode-cancelled] FFmpeg task was cancelled."), {
          name: "AbortError",
        }));
        return;
      }
      if (options.acceptExitCode?.(code) || code === 0) {
        resolve({ stderr });
        return;
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-8).join(" | ");
      reject(new Error(
        `[video-transcode-failed] FFmpeg exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${tail}`,
      ));
    });
  });
}

export function selectRandomVideoFrameTimestamps(
  durationSeconds: number,
  count = 2,
  random: () => number = Math.random,
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("[video-frame-extract-failed] 视频时长无效。");
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("[video-frame-extract-failed] 截图数量必须是正整数。");
  }

  const safeStart = durationSeconds * 0.1;
  const safeDuration = durationSeconds * 0.8;
  const segmentDuration = safeDuration / count;
  return Array.from({ length: count }, (_unused, index) => {
    const randomValue = Math.min(0.999_999, Math.max(0, random()));
    return safeStart + segmentDuration * (index + randomValue);
  });
}

export async function extractRandomVideoFrames(options: ExtractRandomVideoFramesRequest) {
  const count = options.count ?? 2;
  const durationSeconds = await readVideoDurationSeconds(options.inputFile, options.signal);
  const timestamps = selectRandomVideoFrameTimestamps(durationSeconds, count, options.random);
  await mkdir(options.outputDir, { recursive: true });

  const files: string[] = [];
  for (const [index, timestamp] of timestamps.entries()) {
    options.signal?.throwIfAborted();
    const outputFile = path.join(
      options.outputDir,
      `frame-${index + 1}-${timestamp.toFixed(3).replace(".", "_")}.jpg`,
    );
    options.onLog?.(`正在从第一集抽取第 ${index + 1}/${count} 张 AI 参考帧（${timestamp.toFixed(1)} 秒）`);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-ss", timestamp.toFixed(3),
      "-i", options.inputFile,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-q:v", "2",
      "-y",
      outputFile,
    ], { signal: options.signal });
    const outputStat = await stat(outputFile).catch(() => undefined);
    if (!outputStat?.isFile() || outputStat.size <= 0) {
      throw new Error(`[video-frame-extract-failed] 第一集参考帧生成失败：${outputFile}`);
    }
    files.push(outputFile);
  }
  return { durationSeconds, files, timestamps };
}

export async function readVideoDurationSeconds(inputFile: string, signal?: AbortSignal) {
  const result = await runFfmpeg(
    ["-hide_banner", "-i", inputFile],
    {
      signal,
      acceptExitCode: (code) => code === 1,
    },
  );
  const match = durationPattern.exec(result.stderr);
  if (!match) {
    throw new Error(`[video-transcode-failed] 无法读取视频时长: ${inputFile}`);
  }
  const durationSeconds = secondsFromDurationMatch(match);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`[video-transcode-failed] 视频时长无效: ${inputFile}`);
  }
  return durationSeconds;
}

export async function readVideoStreamMetadata(
  inputFile: string,
  signal?: AbortSignal,
): Promise<VideoStreamMetadata> {
  const [result, fileStat] = await Promise.all([
    runFfmpeg(
      ["-hide_banner", "-i", inputFile],
      { signal, acceptExitCode: (code) => code === 1 },
    ),
    stat(inputFile),
  ]);
  const durationMatch = durationPattern.exec(result.stderr);
  const dimensionsMatch = videoDimensionsPattern.exec(result.stderr);
  const durationSeconds = durationMatch ? secondsFromDurationMatch(durationMatch) : 0;
  const width = Number(dimensionsMatch?.[1]);
  const height = Number(dimensionsMatch?.[2]);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`[video-transcode-failed] 无法读取视频时长: ${inputFile}`);
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`[video-transcode-failed] 无法读取视频分辨率: ${inputFile}`);
  }
  const videoStreamLine = [...result.stderr.matchAll(videoStreamPattern)][0]?.[0] ?? "";
  const streamBitrate = Number(streamBitratePattern.exec(videoStreamLine)?.[1]);
  if (Number.isFinite(streamBitrate) && streamBitrate > 0) {
    return { durationSeconds, width, height, videoBitrateKbps: streamBitrate, bitrateSource: "stream" };
  }
  // Some MP4 encoders omit the per-stream bitrate. File size divided by
  // duration is still a fast, conservative approximation; reserve 160 kbps
  // for audio and container overhead so borderline files are re-encoded.
  const estimatedVideoBitrateKbps = Math.max(
    minimumVideoBitrateKbps,
    Math.floor(fileStat.size * 8 / durationSeconds / 1000) - defaultAudioBitrateKbps - 32,
  );
  return {
    durationSeconds,
    width,
    height,
    videoBitrateKbps: estimatedVideoBitrateKbps,
    bitrateSource: "estimated",
  };
}

export async function readVideoDimensions(
  inputFile: string,
  signal?: AbortSignal,
): Promise<VideoDimensions> {
  const result = await runFfmpeg(
    ["-hide_banner", "-i", inputFile],
    { signal, acceptExitCode: (code) => code === 1 },
  );
  const match = videoDimensionsPattern.exec(result.stderr);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`[video-transcode-failed] 无法读取视频分辨率: ${inputFile}`);
  }
  return { width, height };
}

export async function ensureVideoMinimumDimensions(
  request: EnsureVideoMinimumDimensionsRequest,
) {
  const minimumWidth = Math.floor(request.minimumWidth);
  const minimumHeight = Math.floor(request.minimumHeight);
  if (minimumWidth <= 0 || minimumHeight <= 0) {
    throw new Error("[video-transcode-failed] 视频最小宽高必须为正整数。");
  }
  const source = await readVideoDimensions(request.inputFile, request.signal);
  if (source.width >= minimumWidth && source.height >= minimumHeight) {
    return { file: request.inputFile, source, output: source, transcoded: false };
  }

  const targetShortEdge = Math.max(minimumWidth, minimumHeight);
  const temporaryOutput = `${request.outputFile}.${process.pid}-${Date.now()}.tmp.mp4`;
  await mkdir(path.dirname(request.outputFile), { recursive: true });
  await rm(temporaryOutput, { force: true }).catch(() => undefined);
  request.onLog?.(
    `[video-dimensions] ${path.basename(request.inputFile)} ${source.width}x${source.height} ` +
      `不符合最小 ${minimumWidth}x${minimumHeight}，开始转换`,
  );
  try {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-i", request.inputFile,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-filter:v",
      `scale='if(lt(iw,ih),${targetShortEdge},-2)':'if(gte(iw,ih),${targetShortEdge},-2)'`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      temporaryOutput,
    ], { signal: request.signal });
    const output = await readVideoDimensions(temporaryOutput, request.signal);
    if (output.width < minimumWidth || output.height < minimumHeight) {
      throw new Error(
        `[video-transcode-failed] 转换后分辨率仍不符合要求: ` +
          `${output.width}x${output.height}, minimum=${minimumWidth}x${minimumHeight}`,
      );
    }
    const outputStat = await stat(temporaryOutput);
    if (!outputStat.isFile() || outputStat.size <= 0) {
      throw new Error(`[video-transcode-failed] FFmpeg 未生成有效视频: ${request.inputFile}`);
    }
    await rm(request.outputFile, { force: true }).catch(() => undefined);
    await rename(temporaryOutput, request.outputFile);
    request.onLog?.(
      `[video-dimensions] ${path.basename(request.inputFile)} 转换完成：` +
        `${source.width}x${source.height} -> ${output.width}x${output.height}`,
    );
    return { file: request.outputFile, source, output, transcoded: true };
  } finally {
    await rm(temporaryOutput, { force: true }).catch(() => undefined);
  }
}

async function videoHasAudioStream(inputFile: string, signal?: AbortSignal) {
  const result = await runFfmpeg(
    ["-hide_banner", "-i", inputFile],
    { signal, acceptExitCode: (code) => code === 1 },
  );
  return /^\s*Stream #\d+:\d+.*?: Audio:/mu.test(result.stderr);
}

async function readDecodedStreamDurationSeconds(
  inputFile: string,
  stream: "video" | "audio",
  signal?: AbortSignal,
) {
  const result = await runFfmpeg([
    "-hide_banner",
    "-xerror",
    "-i", inputFile,
    "-map", stream === "video" ? "0:v:0" : "0:a:0",
    "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ], { signal });
  const matches = [...result.stderr.matchAll(progressTimePattern)];
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch) {
    throw new Error(
      `[video-speed-failed] 无法读取${stream === "video" ? "画面" : "音频"}轨解码时长: ${inputFile}`,
    );
  }
  const durationSeconds = secondsFromDurationMatch(lastMatch);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      `[video-speed-failed] ${stream === "video" ? "画面" : "音频"}轨解码时长无效: ${inputFile}`,
    );
  }
  return durationSeconds;
}

export async function adjustVideoPlaybackSpeed(
  request: VideoPlaybackSpeedRequest,
): Promise<AdjustedVideoPlaybackSpeed> {
  if (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2) {
    throw new Error(`[video-speed-invalid] 播放速度必须在 0.5 至 2 之间: ${request.speed}`);
  }
  const sourceDurationSeconds = request.sourceDurationSeconds
    ?? await readVideoDurationSeconds(request.inputFile, request.signal);
  const hasAudio = await videoHasAudioStream(request.inputFile, request.signal);
  const expectedDurationSeconds = sourceDurationSeconds / request.speed;
  const temporaryOutput = path.join(
    path.dirname(request.inputFile),
    `.${path.basename(request.inputFile)}.${process.pid}-${Date.now()}.speed.tmp.mp4`,
  );
  await rm(temporaryOutput, { force: true }).catch(() => undefined);
  request.onLog?.(
    `[video-speed] 开始处理 ${path.basename(request.inputFile)}: `
      + `${sourceDurationSeconds.toFixed(2)}秒 speed=${request.speed}`,
  );
  try {
    const args = [
      "-y",
      "-hide_banner",
      "-fflags", "+genpts",
      "-i", request.inputFile,
      "-map", "0:v:0",
      "-filter:v", `settb=AVTB,setpts=(PTS-STARTPTS)/${request.speed}`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-threads", "2",
    ];
    if (hasAudio) {
      args.push(
        "-map", "0:a:0?",
        "-filter:a",
        `aresample=48000:async=1:first_pts=0,atempo=${request.speed},`
          + `asetpts=N/SR/TB,apad=whole_dur=${expectedDurationSeconds.toFixed(6)}`,
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-ac", "2",
      );
    } else {
      args.push("-an");
    }
    args.push(
      "-t", expectedDurationSeconds.toFixed(6),
      "-fps_mode", "cfr",
      "-avoid_negative_ts", "make_zero",
      "-max_muxing_queue_size", "2048",
      "-movflags", "+faststart",
      temporaryOutput,
    );
    await runFfmpeg(args, { signal: request.signal });

    const outputStat = await stat(temporaryOutput);
    if (!outputStat.isFile() || outputStat.size <= 0) {
      throw new Error(`[video-speed-failed] FFmpeg 未生成有效视频: ${request.inputFile}`);
    }
    const outputDurationSeconds = await readVideoDurationSeconds(temporaryOutput, request.signal);
    const outputVideoDurationSeconds = await readDecodedStreamDurationSeconds(
      temporaryOutput,
      "video",
      request.signal,
    );
    const outputAudioDurationSeconds = hasAudio
      ? await readDecodedStreamDurationSeconds(temporaryOutput, "audio", request.signal)
      : undefined;
    const toleranceSeconds = Math.max(0.25, expectedDurationSeconds * 0.01);
    if (Math.abs(outputDurationSeconds - expectedDurationSeconds) > toleranceSeconds) {
      throw new Error(
        `[video-speed-failed] 调速后时长不符合预期: source=${sourceDurationSeconds.toFixed(2)} `
          + `expected=${expectedDurationSeconds.toFixed(2)} actual=${outputDurationSeconds.toFixed(2)} `
          + `file=${request.inputFile}`,
      );
    }
    if (Math.abs(outputVideoDurationSeconds - expectedDurationSeconds) > toleranceSeconds) {
      throw new Error(
        `[video-speed-failed] 调速后画面轨时长不符合预期: `
          + `expected=${expectedDurationSeconds.toFixed(2)} actual=${outputVideoDurationSeconds.toFixed(2)} `
          + `file=${request.inputFile}`,
      );
    }
    if (
      outputAudioDurationSeconds !== undefined
      && (
        Math.abs(outputAudioDurationSeconds - expectedDurationSeconds) > toleranceSeconds
        || Math.abs(outputAudioDurationSeconds - outputVideoDurationSeconds) > toleranceSeconds
      )
    ) {
      throw new Error(
        `[video-speed-failed] 调速后音画轨时长不一致: `
          + `video=${outputVideoDurationSeconds.toFixed(2)} audio=${outputAudioDurationSeconds.toFixed(2)} `
          + `expected=${expectedDurationSeconds.toFixed(2)} file=${request.inputFile}`,
      );
    }
    await replaceSourceFile({
      sourceFile: request.inputFile,
      transcodedFile: temporaryOutput,
      expectedSize: outputStat.size,
    });
    request.onLog?.(
      `[video-speed] 处理完成 ${path.basename(request.inputFile)}: `
        + `${sourceDurationSeconds.toFixed(2)}秒 -> ${outputDurationSeconds.toFixed(2)}秒`,
    );
    return {
      file: request.inputFile,
      speed: request.speed,
      sourceDurationSeconds,
      outputDurationSeconds,
      outputVideoDurationSeconds,
      outputAudioDurationSeconds,
    };
  } finally {
    await rm(temporaryOutput, { force: true }).catch(() => undefined);
  }
}

async function cacheKeyFor(inputFile: string, policy: VideoSizePolicy) {
  const fileStat = await stat(inputFile);
  const sampleSize = 1024 * 1024;
  const firstSampleSize = Math.min(sampleSize, fileStat.size);
  const lastSampleSize = Math.min(sampleSize, Math.max(0, fileStat.size - firstSampleSize));
  const contentHash = createHash("sha256");
  const handle = await open(inputFile, "r");
  try {
    const updateFromSample = async (position: number, length: number) => {
      if (length <= 0) return;
      const sample = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(
          sample,
          offset,
          length - offset,
          position + offset,
        );
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      contentHash.update(sample.subarray(0, offset));
    };
    await updateFromSample(0, firstSampleSize);
    await updateFromSample(fileStat.size - lastSampleSize, lastSampleSize);
  } finally {
    await handle.close();
  }
  const fingerprint = JSON.stringify({
    size: fileStat.size,
    contentSample: contentHash.digest("hex"),
    maxFileBytes: policy.maxFileBytes,
    targetFileBytes: policy.targetFileBytes,
    audioBitrateKbps: policy.audioBitrateKbps ?? defaultAudioBitrateKbps,
    minimumVideoBitrateKbps: policy.minimumVideoBitrateKbps ?? 0,
    targetVideoBitrateKbps: policy.targetVideoBitrateKbps ?? 0,
    preset: policy.preset ?? "medium",
    threadsPerJob: policy.threadsPerJob ?? 2,
    version: 3,
  });
  return {
    cacheKey: createHash("sha256").update(fingerprint).digest("hex"),
    fileStat,
  };
}

async function replaceSourceFile(options: {
  sourceFile: string;
  transcodedFile: string;
  expectedSize: number;
}) {
  const sourceDir = path.dirname(options.sourceFile);
  const sourceName = path.basename(options.sourceFile);
  const uniqueSuffix = `${process.pid}-${Date.now()}`;
  const replacementFile = path.join(sourceDir, `.${sourceName}.${uniqueSuffix}.replacement`);
  const backupFile = path.join(sourceDir, `.${sourceName}.${uniqueSuffix}.original`);
  let originalBackedUp = false;
  let replacementInstalled = false;

  try {
    await copyFile(options.transcodedFile, replacementFile);
    const replacementStat = await stat(replacementFile);
    if (!replacementStat.isFile() || replacementStat.size !== options.expectedSize) {
      throw new Error(
        `[video-transcode-failed] 替换文件校验失败: ${replacementFile}`,
      );
    }

    await rename(options.sourceFile, backupFile);
    originalBackedUp = true;
    await rename(replacementFile, options.sourceFile);
    replacementInstalled = true;

    const finalStat = await stat(options.sourceFile);
    if (!finalStat.isFile() || finalStat.size !== options.expectedSize) {
      throw new Error(
        `[video-transcode-failed] 原文件替换后校验失败: ${options.sourceFile}`,
      );
    }
    await rm(backupFile, { force: true });
    originalBackedUp = false;
  } catch (error) {
    if (originalBackedUp) {
      try {
        if (replacementInstalled) {
          await rm(options.sourceFile, { force: true });
        }
        await rename(backupFile, options.sourceFile);
        originalBackedUp = false;
      } catch (restoreError) {
        throw new Error(
          `[video-transcode-failed] 替换失败且恢复原文件失败，原文件备份位于: ${backupFile}; ` +
            `替换错误=${error instanceof Error ? error.message : String(error)}; ` +
            `恢复错误=${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
    throw error;
  } finally {
    await rm(replacementFile, { force: true }).catch(() => undefined);
  }
}

async function transcodeAttempt(options: {
  inputFile: string;
  outputFile: string;
  passLogFile: string;
  durationSeconds: number;
  targetFileBytes: number;
  videoBitrateOverrideKbps?: number;
  policy: VideoSizePolicy;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}) {
  const audioBitrateKbps = options.policy.audioBitrateKbps ?? defaultAudioBitrateKbps;
  const containerReserveKbps = 32;
  const targetTotalKbps = Math.floor(options.targetFileBytes * 8 / options.durationSeconds / 1000);
  const videoBitrateKbps = options.videoBitrateOverrideKbps ?? Math.max(
    minimumVideoBitrateKbps,
    targetTotalKbps - audioBitrateKbps - containerReserveKbps,
  );
  const commonVideoArgs = [
    "-map", "0:v:0",
    "-c:v", "libx264",
    "-preset", options.policy.preset ?? "medium",
    "-b:v", `${videoBitrateKbps}k`,
    "-threads", String(Math.max(1, options.policy.threadsPerJob ?? 2)),
    "-passlogfile", options.passLogFile,
  ];
  if (options.videoBitrateOverrideKbps) {
    commonVideoArgs.push(
      "-minrate", `${videoBitrateKbps}k`,
      "-maxrate", `${videoBitrateKbps}k`,
      "-bufsize", `${videoBitrateKbps * 2}k`,
      "-x264-params", "nal-hrd=cbr:force-cfr=1",
    );
  }

  options.onLog?.(
    `[video-transcode] target=${options.targetFileBytes} bytes duration=${options.durationSeconds.toFixed(2)}s ` +
      `videoBitrate=${videoBitrateKbps}k audioBitrate=${audioBitrateKbps}k`,
  );

  if (options.videoBitrateOverrideKbps) {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-i", options.inputFile,
      ...commonVideoArgs,
      "-map", "0:a:0?",
      "-c:a", "aac",
      "-b:a", `${audioBitrateKbps}k`,
      "-movflags", "+faststart",
      options.outputFile,
    ], { signal: options.signal });
    return;
  }

  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-i", options.inputFile,
    ...commonVideoArgs,
    "-pass", "1",
    "-an",
    "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ], { signal: options.signal });

  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-i", options.inputFile,
    ...commonVideoArgs,
    "-pass", "2",
    "-map", "0:a:0?",
    "-c:a", "aac",
    "-b:a", `${audioBitrateKbps}k`,
    "-movflags", "+faststart",
    options.outputFile,
  ], { signal: options.signal });
}

async function prepareVideoFile(request: VideoTranscodeRequest): Promise<PreparedVideoFile> {
  assertPolicy(request.policy);
  const { cacheKey, fileStat } = await cacheKeyFor(request.inputFile, request.policy);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`[video-transcode-failed] 视频文件不存在或为空: ${request.inputFile}`);
  }
  const minimumRequiredBitrate = request.policy.minimumVideoBitrateKbps ?? 0;
  const sourceMetadata = minimumRequiredBitrate > 0
    ? await readVideoStreamMetadata(request.inputFile, request.signal)
    : undefined;
  const bitrateTooLow = Boolean(
    sourceMetadata && sourceMetadata.videoBitrateKbps < minimumRequiredBitrate,
  );
  if (sourceMetadata) {
    request.onLog?.(
      `[video-bitrate-check] file=${request.inputFile} `
        + `videoBitrate=${sourceMetadata.videoBitrateKbps}k `
        + `minimum=${minimumRequiredBitrate}k source=${sourceMetadata.bitrateSource}`,
    );
  }
  if (fileStat.size <= request.policy.maxFileBytes && !bitrateTooLow) {
    return {
      sourceFile: request.inputFile,
      file: request.inputFile,
      originalSize: fileStat.size,
      outputSize: fileStat.size,
      transcoded: false,
      cacheKey,
    };
  }

  const cacheDir = path.join(request.cacheRootDir, cacheKey);
  const outputFile = path.join(cacheDir, "video.mp4");
  const existingOutput = await stat(outputFile).catch(() => undefined);
  if (
    existingOutput?.isFile()
    && existingOutput.size > 0
    && existingOutput.size < request.policy.maxFileBytes
  ) {
    request.onLog?.(`[video-transcode-cache-hit] ${request.inputFile} -> ${outputFile}`);
    if (request.replaceSource) {
      await replaceSourceFile({
        sourceFile: request.inputFile,
        transcodedFile: outputFile,
        expectedSize: existingOutput.size,
      });
      await rm(cacheDir, { recursive: true, force: true });
      request.onLog?.(
        `[video-transcode-source-replaced] ${request.inputFile} ${fileStat.size} -> ${existingOutput.size} bytes`,
      );
      return {
        sourceFile: request.inputFile,
        file: request.inputFile,
        originalSize: fileStat.size,
        outputSize: existingOutput.size,
        transcoded: true,
        cacheKey,
      };
    }
    return {
      sourceFile: request.inputFile,
      file: outputFile,
      originalSize: fileStat.size,
      outputSize: existingOutput.size,
      transcoded: true,
      cacheKey,
    };
  }

  await mkdir(cacheDir, { recursive: true });
  const durationSeconds = sourceMetadata?.durationSeconds
    ?? await readVideoDurationSeconds(request.inputFile, request.signal);
  const targetBitrate = Math.max(
    minimumRequiredBitrate,
    request.policy.targetVideoBitrateKbps ?? minimumRequiredBitrate,
  );
  const bitrateAttempts = bitrateTooLow ? [targetBitrate, targetBitrate + 300] : [];
  const attemptTargets = bitrateTooLow
    ? bitrateAttempts.map((videoBitrate) => Math.ceil(
        durationSeconds
          * (videoBitrate + (request.policy.audioBitrateKbps ?? defaultAudioBitrateKbps) + 32)
          * 1000 / 8,
      ))
    : [request.policy.targetFileBytes, Math.floor(request.policy.targetFileBytes * 0.94)];

  for (let attempt = 0; attempt < attemptTargets.length; attempt += 1) {
    const temporaryOutput = path.join(cacheDir, `video-attempt-${attempt + 1}.tmp.mp4`);
    const passLogFile = path.join(cacheDir, `ffmpeg-pass-${attempt + 1}`);
    await rm(temporaryOutput, { force: true }).catch(() => undefined);
    try {
      await transcodeAttempt({
        inputFile: request.inputFile,
        outputFile: temporaryOutput,
        passLogFile,
        durationSeconds,
        targetFileBytes: attemptTargets[attempt],
        videoBitrateOverrideKbps: bitrateTooLow ? bitrateAttempts[attempt] : undefined,
        policy: request.policy,
        signal: request.signal,
        onLog: request.onLog,
      });
      const outputStat = await stat(temporaryOutput);
      if (outputStat.size > 0 && outputStat.size < request.policy.maxFileBytes) {
        const outputMetadata = bitrateTooLow
          ? await readVideoStreamMetadata(temporaryOutput, request.signal)
          : undefined;
        const outputDurationSeconds = outputMetadata?.durationSeconds
          ?? await readVideoDurationSeconds(temporaryOutput, request.signal);
        const durationToleranceSeconds = Math.max(1, durationSeconds * 0.02);
        if (Math.abs(outputDurationSeconds - durationSeconds) > durationToleranceSeconds) {
          request.onLog?.(
            `[video-transcode-retry] output duration ${outputDurationSeconds.toFixed(2)}s ` +
              `differs from source ${durationSeconds.toFixed(2)}s`,
          );
          continue;
        }
        if (outputMetadata) {
          if (outputMetadata.videoBitrateKbps < minimumRequiredBitrate) {
            request.onLog?.(
              `[video-transcode-retry] output bitrate ${outputMetadata.videoBitrateKbps}k `
                + `is below ${minimumRequiredBitrate}k`,
            );
            continue;
          }
        }
        await rm(outputFile, { force: true }).catch(() => undefined);
        await rename(temporaryOutput, outputFile);
        if (request.replaceSource) {
          await replaceSourceFile({
            sourceFile: request.inputFile,
            transcodedFile: outputFile,
            expectedSize: outputStat.size,
          });
          await rm(cacheDir, { recursive: true, force: true });
          request.onLog?.(
            `[video-transcode-complete] ${request.inputFile} ${fileStat.size} -> ${outputStat.size} bytes source-replaced=true`,
          );
          return {
            sourceFile: request.inputFile,
            file: request.inputFile,
            originalSize: fileStat.size,
            outputSize: outputStat.size,
            transcoded: true,
            cacheKey,
          };
        }
        request.onLog?.(
          `[video-transcode-complete] ${request.inputFile} ${fileStat.size} -> ${outputStat.size} bytes`,
        );
        return {
          sourceFile: request.inputFile,
          file: outputFile,
          originalSize: fileStat.size,
          outputSize: outputStat.size,
          transcoded: true,
          cacheKey,
        };
      }
      request.onLog?.(
        `[video-transcode-retry] output size ${outputStat.size} is not below ${request.policy.maxFileBytes}`,
      );
    } finally {
      await Promise.all([
        rm(temporaryOutput, { force: true }).catch(() => undefined),
        rm(`${passLogFile}-0.log`, { force: true }).catch(() => undefined),
        rm(`${passLogFile}-0.log.mbtree`, { force: true }).catch(() => undefined),
      ]);
    }
  }

  throw new Error(
    `[video-transcode-failed] 转码后文件仍未低于 ${request.policy.maxFileBytes} 字节: ${request.inputFile}`,
  );
}

export class VideoTranscodeQueue {
  private readonly queue: PQueue;
  private readonly jobsByCacheKey = new Map<string, Promise<PreparedVideoFile>>();
  private readonly onLog?: (message: string) => void;

  constructor(options: VideoTranscodeQueueOptions = {}) {
    this.queue = new PQueue({
      concurrency: Math.max(1, options.concurrency ?? 2),
      timeout: options.timeoutMs,
    });
    this.onLog = options.onLog;
  }

  get size() {
    return this.queue.size;
  }

  get pending() {
    return this.queue.pending;
  }

  async add(request: VideoTranscodeRequest): Promise<PreparedVideoFile> {
    const { cacheKey } = await cacheKeyFor(request.inputFile, request.policy);
    const jobKey = `${cacheKey}:${request.replaceSource ? "replace-source" : "cache-only"}`;
    const existing = this.jobsByCacheKey.get(jobKey);
    if (existing) return existing;

    const job = this.queue.add(
      ({ signal }) => prepareVideoFile({
        ...request,
        signal,
        onLog: request.onLog ?? this.onLog,
      }),
      {
        id: jobKey,
        signal: request.signal,
      },
    ) as Promise<PreparedVideoFile>;
    this.jobsByCacheKey.set(jobKey, job);
    void job.finally(() => {
      if (this.jobsByCacheKey.get(jobKey) === job) {
        this.jobsByCacheKey.delete(jobKey);
      }
    }).catch(() => undefined);
    return job;
  }

  pause() {
    this.queue.pause();
  }

  start() {
    this.queue.start();
  }

  async onIdle() {
    await this.queue.onIdle();
  }
}

export async function prepareEpisodeVideos(options: {
  episodes: Array<{ index: number; title: string; file: string }>;
  queue: VideoTranscodeQueue;
  cacheRootDir: string;
  policy: VideoSizePolicy;
  replaceSource?: boolean;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}) {
  return Promise.all(options.episodes.map(async (episode) => ({
    ...episode,
    ...(await options.queue.add({
      inputFile: episode.file,
      cacheRootDir: options.cacheRootDir,
      policy: options.policy,
      replaceSource: options.replaceSource,
      signal: options.signal,
      onLog: options.onLog,
    })),
  })));
}
