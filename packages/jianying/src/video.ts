import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readVideoDurationSeconds, resolveFfmpegExecutablePath } from "@dramabridge/media-assets";
import { randomSplitPlan, secureRandom, type SplitPlan } from "./plan.js";

export async function inspectVideo(source: string, minSeconds: number, maxSeconds: number): Promise<SplitPlan> {
  if (typeof source !== "string" || !path.isAbsolute(source) || !/\.(mp4|mov|mkv|m4v|avi|webm)$/i.test(source))
    throw new Error("请选择有效的视频文件");
  if (!(await stat(source)).isFile()) throw new Error("视频文件不存在");
  const duration = await readVideoDurationSeconds(source);
  return { source, duration, minSeconds, maxSeconds, clips: randomSplitPlan(duration, minSeconds, maxSeconds, secureRandom) };
}

export async function splitVideo(plan: SplitPlan, options: { signal?: AbortSignal; onProgress?: (message: string) => void; outputParent?: string; threads?: number } = {}) {
  if (options.threads !== undefined && (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > 64)) throw new Error("编码线程数无效");
  const sourceStat = await stat(plan.source);
  if (!sourceStat.isFile()) throw new Error("源视频不可用");
  const duration = await readVideoDurationSeconds(plan.source);
  if (Math.abs(duration - plan.duration) > 0.1) throw new Error("视频时长已变化，请重新生成切点");
  if (!plan.clips.length || plan.clips.length > 500) throw new Error("切点数量无效");
  let end = 0;
  for (const clip of plan.clips) {
    if (![clip.start, clip.duration].every(Number.isFinite) || Math.abs(clip.start - end) > 0.001 || clip.duration <= 0)
      throw new Error("分割计划不连续，请重新生成");
    end += clip.duration;
  }
  if (Math.abs(end - duration) > 1 / 30 + 0.001) throw new Error("分割计划未覆盖完整视频");
  options.signal?.throwIfAborted();
  if (options.outputParent !== undefined && !path.isAbsolute(options.outputParent)) throw new Error("输出目录必须为绝对路径");
  const output = path.join(options.outputParent ?? path.dirname(plan.source), `${path.parse(plan.source).name}-随机分割-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: false });
  const times = plan.clips.slice(1).map(clip => clip.start.toFixed(6)).join(",");
  const args = ["-hide_banner", "-nostdin", "-n", ...(options.threads ? ["-threads", String(options.threads), "-filter_threads", String(options.threads)] : []), "-i", plan.source,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", "fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
    ...(options.threads ? ["-threads:v", String(options.threads)] : []),
    ...(times ? ["-force_key_frames", times] : []),
    "-f", "segment", ...(times ? ["-segment_times", times] : ["-segment_time", String(duration + 1)]),
    "-segment_time_delta", String(1 / 60), "-reset_timestamps", "1", "-segment_start_number", "1",
    "-progress", "pipe:1", path.join(output, "片段-%03d.mp4")];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(resolveFfmpegExecutablePath(), args, { windowsHide: true, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
      let errorText = "";
      let progress = "";
      let lastPercent = -1;
      child.stderr.on("data", chunk => { errorText = (errorText + String(chunk)).slice(-4000); });
      child.stdout.on("data", chunk => {
        progress += String(chunk);
        const lines = progress.split(/\r?\n/);
        progress = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line);
          if (!match) continue;
          const percent = Math.min(99, Math.floor(Number(match[1]) / 1e6 / duration * 100));
          if (percent > lastPercent) { lastPercent = percent; options.onProgress?.(`正在生成分割片段 ${percent}%`); }
        }
      });
      let processError: Error | undefined;
      child.once("error", error => { processError = error; });
      child.once("close", code => processError ? reject(processError) : code === 0 ? resolve() : reject(new Error(options.signal?.aborted ? "已停止分割" : `视频分割失败：${errorText}`)));
    });
    const files = (await readdir(output)).filter(name => /^片段-\d+\.mp4$/.test(name)).sort().map(name => path.join(output, name));
    if (files.length !== plan.clips.length) throw new Error(`实际生成 ${files.length} 段，与计划 ${plan.clips.length} 段不符`);
    options.signal?.throwIfAborted();
    await writeFile(path.join(output, "分割计划.json"), JSON.stringify({ ...plan, files }, null, 2), "utf8");
    return { output, files };
  } catch (error) {
    throw new Error(`${options.signal?.aborted ? "已停止分割" : String(error)}；未完成的片段保留在 ${output}`);
  }
}
