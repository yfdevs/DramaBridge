import type { YoutubeTask } from "@/platforms/youtube-drama/service";
import { YoutubeTaskStatus, youtubeActiveStatuses } from "./task-status";

export const youtubeStageLabels: Record<string, string> = {
  queued: "排队等待",
  downloading: "下载素材",
  preparing: "准备处理",
  probing: "分析素材",
  normalizing: "处理片段",
  merging: "合并视频",
  validating: "校验成片",
  checking_timestamps: "校验时间轴",
  extracting: "提取音轨",
  loading_model: "加载分离模型",
  separating: "分离人声",
  saving_audio: "保存人声",
  remuxing: "重混视频",
  muting: "移除音轨",
  compressing: "压缩视频",
  authorizing: "准备授权",
  uploading: "上传视频",
  thumbnail: "设置封面",
  completed: "处理完成",
};

export function youtubeDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${seconds}秒`;
}

export function YoutubeTaskProgress({
  task,
  open,
  showError = true,
}: {
  task: YoutubeTask;
  open?: () => void;
  showError?: boolean;
}) {
  const progress = task.progress;
  const active = youtubeActiveStatuses.includes(task.status);
  const showDetails = active || task.status === "paused" || task.status === "failed";
  const percent =
    task.status === "completed"
      ? 100
      : typeof progress?.percent === "number" && Number.isFinite(progress.percent)
        ? Math.max(0, Math.min(100, progress.percent))
        : null;
  const started = task.timings?.active?.startedAt;
  const elapsed =
    started && task.timings?.active?.stage === progress?.stage
      ? Math.max(0, (Date.now() - Date.parse(started)) / 1000)
      : progress?.elapsedSeconds;
  const showProgress = showDetails || task.status === "completed";
  return (
    <div className="min-w-0 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <YoutubeTaskStatus status={task.status} />
        {showProgress && percent !== null && (
          <span
            className="tabular-nums text-muted-foreground"
            title={task.status === "completed" ? "任务已完成" : "当前阶段进度"}
          >
            {percent.toFixed(1)}%
          </span>
        )}
      </div>
      {showProgress && percent !== null && (
        <div
          role="progressbar"
          aria-label={`${task.payload.resourceName}当前阶段进度`}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      )}
      {progress?.stage && showDetails && (
        <p className="mt-1.5 font-medium">
          {youtubeStageLabels[progress.stage] ?? "处理中"}
          {progress.episodeIndex && progress.episodeCount
            ? `，第 ${progress.episodeIndex}/${progress.episodeCount} 集`
            : ""}
        </p>
      )}
      {progress?.message && showDetails && (
        <p className="mt-1 line-clamp-2 break-words text-muted-foreground" title={progress.message}>
          {progress.message}
        </p>
      )}
      {showDetails && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {elapsed !== undefined && Number.isFinite(elapsed) && (
            <span>已耗时 {youtubeDuration(elapsed)}</span>
          )}
          {progress?.speedText && <span>{progress.speedText}</span>}
          {progress?.etaText && (
            <span>
              预计{progress.etaScope === "item" ? "本集" : "本阶段"}剩余 {progress.etaText}
            </span>
          )}
          {progress?.processedSeconds !== undefined && progress.durationSeconds !== undefined && (
            <span>
              视频时间 {youtubeDuration(progress.processedSeconds)} /{" "}
              {youtubeDuration(progress.durationSeconds)}
            </span>
          )}
          {progress?.totalItems && !progress.episodeIndex ? (
            <span>
              {progress.completedItems ?? 0} / {progress.totalItems} 项
            </span>
          ) : null}
          {percent === null && <span>此阶段暂不提供百分比</span>}
        </div>
      )}
      {active && (progress?.lastAdvanceSeconds ?? 0) >= 30 && (
        <p className="mt-1 text-[var(--youtube-warning-text)]">
          已 {Math.floor(progress!.lastAdvanceSeconds!)} 秒未推进，进程仍在运行
        </p>
      )}
      {showError &&
        task.error &&
        (open ? (
          <button
            className="mt-1.5 block w-full truncate text-left text-destructive hover:underline"
            title={task.error}
            onClick={open}
          >
            {task.error}
          </button>
        ) : (
          <p className="mt-1.5 break-words text-destructive">{task.error}</p>
        ))}
    </div>
  );
}
