import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { transcribeVideo, type TranscriptionRuntime } from "./transcription.js";

export type TranscriptionEpisode = {
  id: string; source: string; name: string; episode: number; detected: boolean;
  selected: boolean; status: "waiting" | "running" | "success" | "failed" | "cancelled";
  message?: string; subtitlePath?: string; textPath?: string; sentenceCount?: number;
};
export type EpisodeSelection = Pick<TranscriptionEpisode, "id" | "episode" | "selected">;
export type BatchTranscriptionState = {
  status: "idle" | "ready" | "running" | "success" | "partial" | "failed" | "cancelled";
  message: string; directory?: string; output?: string; items: TranscriptionEpisode[];
};
const VIDEO_EXTENSION = /\.(mp4|mov|mkv|avi|m4v|webm|wmv|flv|ts|mts|m2ts)$/i;

function chineseNumber(value: string): number | undefined {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, digit = 0;
  for (const char of value) {
    if (char in digits) digit = digits[char];
    else { total += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char] ?? 0); digit = 0; }
  }
  return total + digit || undefined;
}

export function detectTranscriptionEpisode(filename: string): number | undefined {
  const stem = path.parse(filename).name.trim();
  const explicit = stem.match(/第\s*(\d+)\s*[集话]/)
    ?? stem.match(/(?:^|[\s._-])(?:episode|ep|e)\s*[._-]?(\d+)(?=$|[^\d])/i)
    ?? stem.match(/^(\d{1,4})(?=$|[\s._—–-]|[\u3400-\u9fff])/u)
    ?? stem.match(/[（(](\d{1,4})[）)]$/);
  const chinese = stem.match(/第\s*([零〇一二两三四五六七八九十百千]+)\s*[集话]/);
  const episode = explicit ? Number(explicit[1]) : chinese ? chineseNumber(chinese[1]) : undefined;
  return episode && Number.isInteger(episode) && episode <= 9999 ? episode : undefined;
}

export async function scanTranscriptionEpisodes(directory: string): Promise<TranscriptionEpisode[]> {
  if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error("请选择有效的视频目录。");
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && VIDEO_EXTENSION.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  if (!entries.length) throw new Error("目录中没有视频，请选择直接包含剧集视频的文件夹。");
  if (entries.length > 9999) throw new Error("单次最多识别 9999 集，请分目录处理。");
  const detected = entries.map(entry => detectTranscriptionEpisode(entry.name));
  const used = new Set(detected.filter((value): value is number => value !== undefined));
  let next = 1;
  return entries.map((entry, index) => {
    while (used.has(next)) next++;
    const episode = detected[index] ?? next++;
    used.add(episode);
    return { id: randomUUID(), source: path.join(directory, entry.name), name: entry.name,
      episode, detected: detected[index] !== undefined, selected: true, status: "waiting" as const };
  }).sort((a, b) => a.episode - b.episode || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

export function selectTranscriptionEpisodes(items: TranscriptionEpisode[], selections: EpisodeSelection[]): TranscriptionEpisode[] {
  if (!Array.isArray(selections) || selections.length !== items.length) throw new Error("剧集列表已变化，请重新选择目录。");
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set<string>();
  const episodes = new Set<number>();
  const result = selections.map(selection => {
    const item = selection && byId.get(selection.id);
    if (!item || seen.has(selection.id) || typeof selection.selected !== "boolean") throw new Error("剧集列表无效，请重新选择目录。");
    seen.add(selection.id);
    if (!Number.isInteger(selection.episode) || selection.episode < 1 || selection.episode > 9999) throw new Error("集数编号须为 1–9999 的整数。");
    if (selection.selected && episodes.has(selection.episode)) throw new Error(`第 ${selection.episode} 集重复，请修改编号或取消勾选其中一个视频。`);
    if (selection.selected) episodes.add(selection.episode);
    return { ...item, episode: selection.episode, selected: selection.selected, status: "waiting" as const, message: undefined, subtitlePath: undefined, textPath: undefined, sentenceCount: undefined };
  });
  if (!episodes.size) throw new Error("请至少选择一集。");
  return result.sort((a, b) => a.episode - b.episode);
}

export async function transcribeEpisodes(options: {
  items: TranscriptionEpisode[]; output: string; runtime: TranscriptionRuntime; signal?: AbortSignal;
  onProgress?: (items: TranscriptionEpisode[], message: string) => void;
}, recognize: typeof transcribeVideo = transcribeVideo) {
  const { output, runtime, signal, onProgress } = options;
  let items = selectTranscriptionEpisodes(options.items, options.items.map(({ id, episode, selected }) => ({ id, episode, selected })));
  signal?.throwIfAborted();
  await mkdir(output, { recursive: true });
  const selected = items.filter(item => item.selected);
  const publish = (message: string) => onProgress?.(items.map(item => ({ ...item })), message);
  for (let index = 0; index < selected.length; index++) {
    const item = selected[index];
    if (signal?.aborted) break;
    item.status = "running";
    const label = `第 ${item.episode} 集（${index + 1}/${selected.length}）`;
    publish(`${label}：正在识别`);
    try {
      const result = await recognize({ source: item.source, outputRoot: path.join(output, "识别记录"), runtime, signal,
        onProgress: message => { item.message = message; publish(`${label}：${message}`); } });
      signal?.throwIfAborted();
      const stem = `第${String(item.episode).padStart(2, "0")}集`;
      const subtitlePath = path.join(output, `${stem}.srt`);
      const textPath = path.join(output, `${stem}.txt`);
      await copyFile(result.subtitlePath, subtitlePath);
      await copyFile(result.textPath, textPath);
      // Commit the completed pair before checking cancellation, preserving finished files.
      item.status = "success"; item.subtitlePath = subtitlePath; item.textPath = textPath;
      item.sentenceCount = result.sentenceCount;
      item.message = result.sentenceCount ? `${result.sentenceCount} 段字幕` : "未检测到语音，已保存空字幕";
      publish(`${label}：已保存字幕`);
    } catch (error) {
      item.status = signal?.aborted ? "cancelled" : "failed";
      item.message = signal?.aborted ? "已停止" : error instanceof Error ? error.message : "识别失败";
      publish(`${label}：${item.message}`);
      if (signal?.aborted) break;
    }
  }
  if (signal?.aborted) items = items.map(item => item.selected && item.status === "waiting" ? { ...item, status: "cancelled", message: "未开始，已停止" } : item);
  const succeeded = items.filter(item => item.selected && item.status === "success").length;
  const failed = items.filter(item => item.selected && item.status === "failed").length;
  const status = signal?.aborted ? "cancelled" : failed ? succeeded ? "partial" : "failed" : "success";
  const message = signal?.aborted ? `已停止，保留已完成的 ${succeeded} 集字幕。`
    : `识别结束：完成 ${succeeded} 集${failed ? `，失败 ${failed} 集，请查看对应原因` : "，已生成独立字幕文件"}。`;
  return { items, status, message, output } satisfies Partial<BatchTranscriptionState>;
}
