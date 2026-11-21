import { randomInt } from "node:crypto";

export type Clip = { index: number; start: number; duration: number };
export type SplitPlan = { source: string; duration: number; minSeconds: number; maxSeconds: number; clips: Clip[] };

/** Frame-aligned random cuts. Preserve every frame and the original ordering. */
export function randomSplitPlan(duration: number, minSeconds: number, maxSeconds: number, sample = Math.random): Clip[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error("视频时长无效或超过 24 小时");
  if (![minSeconds, maxSeconds].every(Number.isFinite) || minSeconds < 0.5 || maxSeconds > 3600 || minSeconds > maxSeconds)
    throw new Error("片段时长须在 0.5–3600 秒之间，最短时长不能大于最长时长");
  const total = Math.max(1, Math.round(duration * 30));
  const min = Math.ceil(minSeconds * 30);
  const max = Math.floor(maxSeconds * 30);
  const lowest = Math.ceil(total / max);
  const highest = Math.floor(total / min);
  if (total <= max) return [{ index: 1, start: 0, duration: total / 30 }];
  if (lowest > highest) throw new Error("当前时长无法完整分成此范围的片段，请放宽最短与最长时长");
  if (lowest > 500) throw new Error("片段数量超过 500，请增大片段时长");
  const count = Math.min(500, highest, Math.max(lowest, Math.round(total / ((min + max) / 2))));
  let remaining = total;
  let start = 0;
  const clips: Clip[] = [];
  for (let index = 1; index <= count; index++) {
    const left = count - index;
    const low = Math.max(min, remaining - left * max);
    const high = Math.min(max, remaining - left * min);
    const value = sample();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("随机数无效");
    const frames = low + Math.floor(value * (high - low + 1));
    clips.push({ index, start: start / 30, duration: frames / 30 });
    start += frames;
    remaining -= frames;
  }
  return clips;
}

export function secureRandom() { return randomInt(0, 0x100000000) / 0x100000000; }
