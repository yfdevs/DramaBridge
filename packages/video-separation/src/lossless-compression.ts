import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export type CompressionTools = { ffmpeg: string; ffprobe: string };
export type CompressionEffort = "fast" | "smallest" | "balanced";
export type CompressionProgress = { stage: string; percent?: number; speed?: string };
export type CompressionState = {
  status: "idle" | "ready" | "running" | "success" | "target-unmet" | "failed" | "cancelled";
  message: string; source?: CompressionVideo; targetBytes?: number; progress?: CompressionProgress;
  outputDirectory?: string; result?: CompressionResult; effort?: CompressionEffort;
  items?: CompressionItem[];
};
export type CompressionVideo = { file: string; name: string; bytes: number; duration: number; width: number; height: number; codec: string; pixelFormat: string };
export type CompressionResult = {
  inputBytes: number; outputBytes: number; targetBytes: number; targetMet: boolean;
  playbackVerified?: boolean;
  verified: boolean; method: string; outputFile?: string; outputDirectory: string;
  attempts?: { method: string; outcome: string; bytes?: number }[];
};
type Stream = Record<string, unknown> & { index: number; codec_type: string; disposition?: { attached_pic?: number }; tags?: Record<string, string>; side_data_list?: Record<string, unknown>[] };
type Probe = { streams: Stream[]; format: { duration?: string }; chapters?: unknown[] };

export function validateCompressionTarget(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 1024 ** 4) throw new Error("目标体积须在 1 KB 到 1 TB 之间。");
  return bytes;
}

async function command(executable: string, args: string[], signal?: AbortSignal, onTime?: (seconds: number, speed?: string) => void) {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", pending = "", speed: string | undefined;
    let failure: Error | undefined;
    const abort = () => { failure = new DOMException("已停止视频压缩", "AbortError"); child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8 * 1024 * 1024) { failure = new Error("媒体组件返回的数据过大。"); child.kill(); }
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString("utf8")).slice(-12000);
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("speed=")) speed = line.slice(6).trim();
        if (line.startsWith("out_time_us=")) onTime?.(Number(line.slice(12)) / 1e6, speed);
      }
    });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    child.once("error", () => { cleanup(); reject(new Error("无法启动媒体组件，请检查 FFmpeg 安装是否完整。")); });
    child.once("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`媒体处理失败：${stderr.replace(/^(?:frame|fps|bitrate|total_size|out_time\w*|dup_frames|drop_frames|speed|progress)=.*$/gm, "").trim().slice(-1500) || `退出码 ${code}`}`));
      else resolve(stdout);
    });
  });
}

async function probe(file: string, tools: CompressionTools, signal?: AbortSignal): Promise<Probe> {
  const value = JSON.parse(await command(tools.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", file], signal));
  if (!Array.isArray(value.streams)) throw new Error("无法读取视频轨道信息。");
  return value;
}

function primary(info: Probe) {
  const videos = info.streams.filter(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (videos.length !== 1) throw new Error("严格无损压缩目前支持单画面视频；多画面轨道文件请先拆分处理。");
  return videos[0];
}

export async function inspectCompressionVideo(file: string, tools: CompressionTools, signal?: AbortSignal): Promise<CompressionVideo> {
  if (!path.isAbsolute(file) || !(await stat(file)).isFile()) throw new Error("请选择有效的视频文件。");
  const info = await probe(file, tools, signal), video = primary(info);
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !video.pix_fmt) throw new Error("无法读取视频时长或像素格式，不能确认无损压缩。");
  return { file, name: path.basename(file), bytes: (await stat(file)).size, duration,
    width: Number(video.width), height: Number(video.height), codec: String(video.codec_name), pixelFormat: String(video.pix_fmt) };
}

export function decodedHashes(stdout: string) {
  const rows = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!rows.length || rows.some(line => !/^\d+,[av],SHA256=[a-f0-9]{64}$/i.test(line))) throw new Error("无法完成音画哈希校验，结果不会标记为无损。");
  return rows.sort().join("\n");
}

export function assertLosslessMetadata(before: Probe, after: Probe) {
  if (before.streams.length !== after.streams.length) throw new Error("输出轨道数量发生变化。");
  let timelineOffset: number | undefined;
  for (let i = 0; i < before.streams.length; i++) {
    const a = before.streams[i], b = after.streams[i];
    if (a.codec_type !== b.codec_type) throw new Error("输出轨道顺序发生变化。");
    const fields = a.codec_type === "video"
      ? ["width", "height", "pix_fmt", "sample_aspect_ratio", "color_range", "color_space", "color_transfer", "color_primaries", "field_order", "r_frame_rate"]
      : a.codec_type === "audio" ? ["codec_name", "sample_rate", "channels", "channel_layout"] : ["codec_name"];
    for (const field of fields) {
      const left = a[field], right = b[field];
      if (left !== undefined && left !== "unknown" && left !== "N/A" && left !== right) throw new Error(`输出的 ${field} 信息发生变化。`);
    }
    const rotation = (stream: Stream) => stream.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? Number(stream.tags?.rotate ?? 0);
    if (rotation(a) !== rotation(b)) throw new Error("输出的旋转方向发生变化。");
    const hdr = (stream: Stream) => (stream.side_data_list ?? []).filter(data => /mastering|content light|dovi|hdr/i.test(String(data.side_data_type)));
    if (JSON.stringify(hdr(a)) !== JSON.stringify(hdr(b))) throw new Error("输出的 HDR 信息发生变化。");
    if (["audio", "video"].includes(a.codec_type) && a.start_time !== undefined && b.start_time !== undefined) {
      const offset = Number(b.start_time) - Number(a.start_time);
      if (Number.isFinite(offset)) {
        timelineOffset ??= offset;
        if (Math.abs(offset - timelineOffset) > 0.002) throw new Error("输出音画的相对起始时间发生变化。");
      }
    }
  }
  const durationA = Number(before.format.duration), durationB = Number(after.format.duration);
  if (!Number.isFinite(durationB) || Math.abs(durationA - durationB) > 0.05) throw new Error("输出时长发生变化。");
}

async function hashFile(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest("hex");
}

export async function compressVideoLosslessly(options: {
  source: string; targetBytes: number; outputDirectory: string; tools: CompressionTools;
  signal?: AbortSignal; onProgress?: (value: CompressionProgress) => void; effort?: CompressionEffort; outputStem?: string;
}): Promise<CompressionResult> {
  const { source, tools, outputDirectory, signal, onProgress } = options;
  const targetBytes = validateCompressionTarget(options.targetBytes);
  if (!path.isAbsolute(outputDirectory)) throw new Error("压缩结果目录必须是绝对路径。");
  const sourceStat = await stat(source);
  const info = await probe(source, tools, signal), video = primary(info);
  const duration = Number(info.format.duration);
  if (!sourceStat.isFile() || !Number.isFinite(duration) || duration <= 0) throw new Error("无法读取完整视频信息。");
  const unchanged = async () => {
    const current = await stat(source);
    if (current.size !== sourceStat.size || current.mtimeMs !== sourceStat.mtimeMs || current.ino !== sourceStat.ino) throw new Error("压缩期间原视频发生变化，请重新选择后重试。");
    signal?.throwIfAborted();
  };
  await mkdir(outputDirectory, { recursive: true });
  const stem = options.outputStem ?? path.parse(source).name;
  const extension = options.effort === "smallest" ? ".mkv" : [".mp4", ".mov", ".mkv"].includes(path.extname(source).toLowerCase()) ? path.extname(source).toLowerCase() : ".mkv";
  const outputFile = path.join(outputDirectory, `${stem}-无损压缩${extension}`);
  if (await stat(outputFile).catch(() => null)) throw new Error("结果文件已存在，请使用新的任务目录。");
  const token = randomUUID();
  const temporary: string[] = [];
  const progress = (stage: string, seconds?: number, speed?: string) => onProgress?.({ stage, percent: seconds === undefined ? undefined : Math.min(99, Math.max(0, seconds / duration * 100)), speed });
  const ffmpeg = (args: string[], stage: string) => {
    progress(stage);
    return command(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-progress", "pipe:2", "-stats_period", "0.5", ...args], signal, (seconds, speed) => progress(stage, seconds, speed));
  };
  let bestFile: string | undefined, bestBytes = sourceStat.size, method = "原文件", sourceHashes: Promise<string> | undefined;
  const hashDecoded = async (file: string) => decodedHashes(await command(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-noautorotate", "-i", file,
    "-map", "0:v", "-map", "0:a?", "-c:v", "rawvideo", "-threads:v", "1", "-c:a", "pcm_f64le", "-fps_mode", "passthrough", "-f", "streamhash", "-hash", "sha256", "-"], signal));
  const consider = async (file: string, candidateMethod: string) => {
    const bytes = (await stat(file)).size;
    if (!bytes || bytes >= bestBytes) return false;
    progress("正在校验完整音画，确认像素与音频一致");
    assertLosslessMetadata(info, await probe(file, tools, signal));
    sourceHashes ??= hashDecoded(source);
    if (await sourceHashes !== await hashDecoded(file)) throw new Error("音画哈希不一致，该结果已丢弃。");
    await unchanged();
    bestFile = file; bestBytes = bytes; method = candidateMethod;
    return bytes < targetBytes;
  };
  const warnings: string[] = [];
  const attempts: NonNullable<CompressionResult["attempts"]> = [];
  try {
    // No re-encoding when the original already satisfies the strict size limit.
    if (sourceStat.size < targetBytes) {
      progress("原视频已低于目标体积，正在原样复制");
      const copied = path.join(outputDirectory, `${stem}-原样保留${path.extname(source)}`);
      await copyFile(source, copied, constants.COPYFILE_EXCL);
      temporary.push(copied);
      progress("正在校验原样复制文件");
      if (await hashFile(source, signal) !== await hashFile(copied, signal)) throw new Error("文件复制校验失败。");
      await unchanged();
      temporary.splice(temporary.indexOf(copied), 1);
      const result = { inputBytes: sourceStat.size, outputBytes: sourceStat.size, targetBytes, targetMet: true, verified: true, method: "原样复制", outputFile: copied, outputDirectory };
      return result;
    }
    const input = ["-noautorotate", "-i", source, "-map", "0", "-map_metadata", "0", "-map_chapters", "0", "-c", "copy"];
    let met = false;
    const remux = path.join(outputDirectory, `整理中-${token}${extension}`); temporary.push(remux);
    try { await ffmpeg([...input, "-n", remux], "正在快速整理封装，不重新编码"); met = await consider(remux, "原码流封装优化"); attempts.push({ method: "原码流封装优化", bytes: (await stat(remux)).size, outcome: bestFile === remux ? "已通过完整无损校验" : "未得到更小文件" }); }
    catch (error) { if (signal?.aborted) throw error; warnings.push(String(error)); }
    // Lossless re-encoding requires special decoder profiles. Only explicitly
    // requested archival output may use them; normal output keeps source bitstreams.
    if (!met && options.effort === "smallest") {
      const encoders = await command(tools.ffmpeg, ["-hide_banner", "-encoders"], signal);
      const ordinal = info.streams.filter(stream => stream.codec_type === "video").findIndex(stream => stream.index === video.index);
      const suffix = `v:${ordinal}`;
      const plans = [
        { encoder: "hevc_nvenc", label: "GPU 无损编码", args: [`-preset:${suffix}`, "p3", `-tune:${suffix}`, "lossless", `-rc:${suffix}`, "constqp", `-qp:${suffix}`, "0"] },
        { encoder: String(video.pix_fmt).startsWith("rgb") || String(video.pix_fmt).startsWith("bgr") ? "libx264rgb" : "libx264", label: options.effort === "smallest" ? "CPU 高压缩率无损编码" : "CPU 快速无损编码", args: [`-preset:${suffix}`, options.effort === "smallest" ? "veryslow" : "veryfast", `-qp:${suffix}`, "0", ...(options.effort === "smallest" ? [`-g:${suffix}`, "100000", `-sc_threshold:${suffix}`, "0"] : [])] },
      ];
      if (options.effort === "smallest" && /^yuv/.test(String(video.pix_fmt))) plans.push({ encoder: "libx265", label: "CPU H.265 无损编码", args: [`-preset:${suffix}`, "medium", `-x265-params:${suffix}`, "lossless=1:log-level=error"] });
      // Formats with alpha, or formats unsupported by H.264, use FFV1 without converting pixels.
      if (extension === ".mkv") plans.push({ encoder: "ffv1", label: "CPU 无损编码", args: ["-level", "3", "-coder", "1", "-context", "1", "-slicecrc", "1"] });
      for (const attempt of plans) {
        if (!new RegExp(`\\b${attempt.encoder}\\b`).test(encoders)) continue;
        const candidate = path.join(outputDirectory, `${attempt.encoder}-处理中-${token}${extension}`); temporary.push(candidate);
        try {
          await ffmpeg([...input, `-c:${suffix}`, attempt.encoder, ...attempt.args,
            `-pix_fmt:${suffix}`, `+${video.pix_fmt}`, `-fps_mode:${suffix}`, "passthrough",
            // Stop spending time on a candidate once it cannot beat the best size.
            // A size-limited/truncated output must still pass full duration and hash checks.
            "-fs", String(bestBytes), "-n", candidate], `正在${attempt.label}`);
          const fits = await consider(candidate, attempt.label);
          attempts.push({ method: attempt.label, bytes: (await stat(candidate)).size, outcome: bestFile === candidate ? "已通过完整无损校验" : "未得到更小的完整无损文件" });
          if (fits) { met = true; break; }
        } catch (error) { if (signal?.aborted) throw error; warnings.push(String(error)); attempts.push({ method: attempt.label, outcome: "编码不可用或未通过完整无损校验" }); }
      }
    }
    if (!met && options.effort !== "smallest") attempts.push({ method: "保留原编码", outcome: "为保留原视频播放兼容性，未使用特殊无损编码" });
    await unchanged();
    if (bestFile) { await rename(bestFile, outputFile); temporary.splice(temporary.indexOf(bestFile), 1); }
    const result: CompressionResult = { inputBytes: sourceStat.size, outputBytes: bestBytes, targetBytes, targetMet: bestBytes < targetBytes, verified: Boolean(bestFile), method, outputFile: bestFile ? outputFile : undefined, outputDirectory, attempts };
    return result;
  } finally {
    await Promise.all(temporary.map(file => rm(file, { force: true }).catch(() => undefined)));
  }
}


/** Target-size encoding for ordinary players; deliberately not described as lossless. */
export async function compressVideoForPlayback(options: {
  source: string; targetBytes: number; outputDirectory: string; tools: CompressionTools;
  signal?: AbortSignal; onProgress?: (value: CompressionProgress) => void; outputStem?: string;
}): Promise<CompressionResult> {
  const { source, tools, outputDirectory, signal, onProgress } = options;
  const targetBytes = validateCompressionTarget(options.targetBytes);
  const original = await stat(source);
  if (original.size < targetBytes) return compressVideoLosslessly(options);
  if (!path.isAbsolute(outputDirectory)) throw new Error("结果目录必须是绝对路径。");
  const info = await probe(source, tools, signal), video = primary(info);
  const duration = Number(info.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长。");
  if (video.color_transfer === "smpte2084" || video.color_transfer === "arib-std-b67") throw new Error("此模式暂不支持 HDR 视频，请使用原编码无损模式，避免颜色变化。");
  const audioRate = info.streams.some(stream => stream.codec_type === "audio") ? 128000 : 0;
  const budget = Math.min(targetBytes, original.size);
  let videoRate = Math.floor((budget - Math.max(65536, budget * 0.04)) * 8 / duration - audioRate);
  if (videoRate < 100000) throw new Error("目标体积太小，无法兼顾清晰画面与声音，请提高体积上限。");
  await mkdir(outputDirectory, { recursive: true });
  const scratch = await mkdtemp(path.join(outputDirectory, "编码临时-"));
  const outputFile = path.join(outputDirectory, `${options.outputStem ?? path.parse(source).name}-清晰压缩.mp4`);
  if (await stat(outputFile).catch(() => null)) { await rm(scratch, { recursive: true, force: true }); throw new Error("结果文件已存在，请使用新的任务目录。"); }
  const candidate = path.join(scratch, "video.mp4");
  const stage = (message: string) => onProgress?.({ stage: message });
  // Keep aspect ratio, never upscale, limit the longer side to 1920 for bitrate efficiency.
  const filter = "scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const base = ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", source];
  try {
    for (let retry = 0; retry < 3; retry++) {
      const encoding = ["-map", `0:${video.index}`, "-vf", filter, "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", String(videoRate), "-passlogfile", path.join(scratch, "pass"), "-fps_mode", "passthrough"];
      const runPass = (args: string[], message: string) => {
        stage(message);
        return command(tools.ffmpeg, ["-progress", "pipe:2", ...args], signal, (seconds, speed) => onProgress?.({ stage: message, percent: Math.min(99, seconds / duration * 100), speed }));
      };
      await runPass([...base, ...encoding, "-pass", "1", "-an", "-f", "null", "-"], "第一遍：分析画面复杂度");
      await runPass([...base, ...encoding, "-pass", "2", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-map_metadata", "0", "-movflags", "+faststart", candidate], "第二遍：生成清晰兼容的视频");
      const bytes = (await stat(candidate)).size;
      if (bytes >= budget) { videoRate = Math.floor(videoRate * budget / bytes * 0.95); continue; }
      stage("正在完整解码检查画面与声音");
      const output = await probe(candidate, tools, signal), picture = primary(output);
      if (picture.codec_name !== "h264" || picture.pix_fmt !== "yuv420p" || !["High", "Main", "Constrained Baseline", "Baseline"].includes(String(picture.profile))) throw new Error("输出编码不符合播放兼容性要求。");
      if (Math.abs(Number(output.format.duration) - duration) > 0.1 || Number(picture.width) < 2 || Number(picture.height) < 2) throw new Error("输出视频不完整。");
      if (audioRate && !output.streams.some(stream => stream.codec_type === "audio")) throw new Error("输出缺少声音。");
      await command(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-xerror", "-i", candidate, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], signal);
      const current = await stat(source);
      if (current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ino !== original.ino) throw new Error("处理期间原视频发生变化，请重试。");
      signal?.throwIfAborted();
      await rename(candidate, outputFile);
      const result: CompressionResult = { inputBytes: original.size, outputBytes: bytes, targetBytes, targetMet: true, verified: false, playbackVerified: true, method: "H.264 两遍清晰压缩（有损）", outputFile, outputDirectory };
      return result;
    }
    throw new Error("未能在保留完整视频的前提下满足体积限制，请提高目标上限。");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}


export type CompressionItem = {
  id: string; file: string; name: string; source?: CompressionVideo;
  status: "ready" | "queued" | "running" | "success" | "target-unmet" | "failed" | "cancelled";
  message: string; progress?: CompressionProgress; result?: CompressionResult;
};

/** A single selection is processed as a batch, with failure isolation and cancellation. */
export async function runCompressionBatch(options: {
  items: CompressionItem[]; targetBytes: number; outputDirectory: string; tools: CompressionTools;
  effort: CompressionEffort; signal?: AbortSignal;
  onUpdate: (items: CompressionItem[]) => void;
}) {
  const { signal, onUpdate } = options;
  const items: CompressionItem[] = options.items.map(item => ({ ...item, status: item.source ? "queued" as const : "failed" as const, progress: undefined, result: undefined }));
  const update = (index: number, patch: Partial<CompressionItem>) => {
    items[index] = { ...items[index], ...patch };
    onUpdate(items.map(item => ({ ...item })));
  };
  onUpdate(items.map(item => ({ ...item })));
  const usedNames = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item.source) continue;
    if (signal?.aborted) { update(index, { status: "cancelled", message: "已停止" }); continue; }
    const base = path.parse(item.name).name;
    let outputStem = base, suffix = 2;
    while (usedNames.has(outputStem.toLowerCase())) outputStem = `${base} (${suffix++})`;
    usedNames.add(outputStem.toLowerCase());
    update(index, { status: "running", message: "准备压缩" });
    try {
      const result = await (options.effort === "balanced" ? compressVideoForPlayback : compressVideoLosslessly)({
        source: item.file, targetBytes: options.targetBytes, tools: options.tools,
        outputDirectory: options.outputDirectory, outputStem, effort: options.effort, signal,
        onProgress: progress => update(index, { progress, message: progress.stage }),
      });
      update(index, { result, progress: undefined, status: result.targetMet ? "success" : "target-unmet",
        message: result.targetMet ? result.method === "原样复制" ? "无需压缩，已原样保存" : "压缩完成" : "未达到体积上限，原视频保留" });
    } catch (error) {
      update(index, { status: signal?.aborted ? "cancelled" : "failed", progress: undefined,
        message: signal?.aborted ? "已停止" : error instanceof Error ? error.message : "压缩失败" });
    }
  }
  return items;
}
