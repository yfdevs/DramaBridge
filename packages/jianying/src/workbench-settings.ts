export type WorkbenchRanges = { videoBlocksMin: number; videoBlocksMax: number; audioBlocksMin: number; audioBlocksMax: number };
export const DEFAULT_WORKBENCH_RANGES: WorkbenchRanges = { videoBlocksMin: 8, videoBlocksMax: 14, audioBlocksMin: 20, audioBlocksMax: 40 };
export function validateWorkbenchRanges(ranges: WorkbenchRanges): WorkbenchRanges {
  for (const [label, min, max, limit] of [
    ["上方视频块", ranges.videoBlocksMin, ranges.videoBlocksMax, 60],
    ["音频总块", ranges.audioBlocksMin, ranges.audioBlocksMax, 80],
  ] as const) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 2 || max > limit || min > max)
      throw new Error(`${label}数量须为 2–${limit} 的整数，最少数量不能大于最多数量`);
  }
  return { ...ranges };
}
