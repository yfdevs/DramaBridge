import type { YoutubeTask } from "@/platforms/youtube-drama/service";

export function youtubeTaskPercent(task: YoutubeTask): number | null {
  if (task.status === "completed") return 100;
  const progress = task.progress;
  const transferred = progress?.transferredBytes;
  const total = progress?.totalBytes;
  // Native transfer sizes also correct cached percentages from older runtimes.
  if (
    progress?.stage === "downloading" &&
    typeof transferred === "number" &&
    Number.isFinite(transferred) &&
    transferred >= 0 &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0 &&
    transferred <= total
  ) {
    return (transferred / total) * 100;
  }
  return typeof progress?.percent === "number" && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, progress.percent))
    : null;
}

export function youtubeTaskElapsed(task: YoutubeTask): number | undefined {
  const active = task.timings?.active;
  const started = active?.startedAt && Date.parse(active.startedAt);
  return typeof started === "number" &&
    Number.isFinite(started) &&
    active?.stage ===
      (task.progress?.stage ?? (task.status === "processing" ? "preparing" : undefined))
    ? Math.max(0, (Date.now() - started) / 1000)
    : task.progress?.elapsedSeconds;
}

export function youtubeBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
  );
  return `${(value / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}

export function youtubeSpeed(value?: string) {
  if (!value) return undefined;
  const bytes = Number(value);
  return value.trim() && Number.isFinite(bytes) && bytes >= 0 ? `${youtubeBytes(bytes)}/s` : value;
}
