import path from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inspectVideo, splitVideo } from "./video.js";
import type { SplitPlan } from "./plan.js";
import { availableParallelism } from "node:os";
import { runConcurrent } from "./concurrency.js";

export type EpisodeSource = { episode: number; source: string };
export type DramaWorkflowSettings = { minSeconds: number; maxSeconds: number };
export const DEFAULT_DRAMA_WORKFLOW_SETTINGS: DramaWorkflowSettings = { minSeconds: 15, maxSeconds: 30 };
export type DramaWorkflowPlan = {
  id: string;
  settings: DramaWorkflowSettings;
  episodes: Array<SplitPlan & { episode: number }>;
  timeline: { duration: number; source: string; cutSeconds: number[]; detachAudioInJianying: true; preserveAudioContinuity: true };
};

/** Require episodes 1–4 regardless of directory ordering. */
export function selectFirstFourEpisodes(episodes: readonly EpisodeSource[]): EpisodeSource[] {
  return [1,2,3,4].map(episode=>{
    const matches=episodes.filter(item=>item.episode===episode);
    if (matches.length!==1) throw new Error(matches.length ? `第 ${episode} 集有多个文件，请只保留一个版本` : `缺少第 ${episode} 集，需要提供第 1–4 集`);
    return {...matches[0]};
  });
}

export async function planDramaWorkflow(episodes: readonly EpisodeSource[], settings = DEFAULT_DRAMA_WORKFLOW_SETTINGS): Promise<DramaWorkflowPlan> {
  if (!Number.isFinite(settings.minSeconds) || !Number.isFinite(settings.maxSeconds)
    || settings.minSeconds < 6 || settings.maxSeconds > 60 || settings.minSeconds > settings.maxSeconds) {
    throw new Error("素材片段时长须在 6–60 秒之间，最短时长不能大于最长时长");
  }
  const selected = selectFirstFourEpisodes(episodes);
  const plans = await Promise.all(selected.map(async item => ({
    ...await inspectVideo(item.source, settings.minSeconds, settings.maxSeconds), episode: item.episode,
  })));
  const original = plans[0];
  return {
    id: randomUUID(), settings: { ...settings }, episodes: plans,
    timeline: { duration: original.duration, source: original.source, cutSeconds: original.clips.slice(1).map(clip => clip.start), detachAudioInJianying: true, preserveAudioContinuity: true },
  };
}

/** Prepare local material only. Native import, detach, split and screenshot are separate verified stages. */
export async function prepareDramaMaterials(plan: DramaWorkflowPlan, outputParent: string, options: {
  signal?: AbortSignal; onProgress?: (message: string) => void; concurrency?: number;
} = {}) {
  const concurrency = options.concurrency ?? Math.min(4,Math.max(1,Math.floor(availableParallelism()/2)));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("并发数必须为 1–6");
  const threads = Math.max(1, Math.min(8, Math.floor(availableParallelism() / concurrency)));
  if (!path.isAbsolute(outputParent)) throw new Error("请选择绝对路径作为输出目录");
  const selected = plan.episodes.map(item=>({episode:item.episode,source:item.source}));
  if (selected.length!==4 || new Set(selected.map(item=>item.episode)).size!==4) throw new Error("素材计划必须包含 4 集不同视频");
  options.signal?.throwIfAborted();
  const output = path.join(outputParent, `剪映素材-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: false });
  const results: Array<{ episode: number; files: string[] }> = [];
  const manifest = (status: "preparing" | "materials-prepared" | "failed", error?: string) => ({
    schemaVersion: 2, status, plan, materials: results,
    nativeStages: { importedToMaterialPanel: false, originalEpisodeOneAddedToTimeline: false, audioDetachedInJianying: false, videoSplitInJianying: false, screenshotSaved: false },
    ...(error ? { error } : {}),
  });
  const manifestPath = path.join(output, "任务计划.json");
  await writeFile(manifestPath, JSON.stringify(manifest("preparing"), null, 2));
  // Concurrent episode completions must never overwrite the manifest simultaneously.
  let writes = Promise.resolve();
  const saveProgress = () => {
    const content = JSON.stringify(manifest("preparing"), null, 2);
    writes = writes.then(() => writeFile(manifestPath, content));
    return writes;
  };
  try {
    options.onProgress?.(`正在并发分割：同时处理 ${concurrency} 集，每集最多 ${threads} 个编码线程`);
    await runConcurrent(selected, concurrency, options.signal, async (item, signal) => {
      signal.throwIfAborted();
      const episodePlan = plan.episodes.find(episode => episode.episode === item.episode)!;
      const result = await splitVideo(episodePlan, {
        signal, outputParent: output, threads,
        onProgress: message => options.onProgress?.(`第 ${item.episode} 集：${message}`),
      });
      const files: string[] = [];
      for (const file of result.files) {
        const named = path.join(path.dirname(file), `第${String(item.episode).padStart(2, "0")}集-${path.basename(file)}`);
        await rename(file, named);
        files.push(named);
      }
      await writeFile(path.join(result.output, "分割计划.json"), JSON.stringify({ ...episodePlan, files }, null, 2));
      results.push({ episode: item.episode, files });
      results.sort((a, b) => a.episode - b.episode);
      await saveProgress();
      options.onProgress?.(`第 ${item.episode} 集完成，已完成 ${results.length}/4 集`);
    });
    await writeFile(manifestPath, JSON.stringify(manifest("materials-prepared"), null, 2));
    return { output, manifestPath, fragments: results, originalEpisodeOne: plan.timeline.source, timelineCutSeconds: [...plan.timeline.cutSeconds] };
  } catch (error) {
    await writes.catch(() => undefined);
    await writeFile(manifestPath, JSON.stringify(manifest("failed", String(error)), null, 2));
    throw new Error(`${String(error)}；任务记录与已生成片段保留在 ${output}`);
  }
}
