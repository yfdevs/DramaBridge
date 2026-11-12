import type { YoutubeTask } from "@/platforms/youtube-drama/service";
import { YoutubeTaskStatus, youtubeActiveStatuses } from "./task-status";
import { youtubeTaskFailure } from "./task-failure";
import {
  youtubeBytes,
  youtubeSpeed,
  youtubeTaskElapsed,
  youtubeTaskPercent,
} from "./task-progress-data";

export const youtubeStageLabels: Record<string, string> = {
  queued: "排队等待",
  downloading: "下载素材",
  preparing: "准备处理",
  waiting_resources: "等待处理",
  scanning: "扫描素材",
  probing: "分析素材",
  normalizing: "处理片段",
  merging: "合并视频",
  validating: "校验视频",
  checking_timestamps: "检查时间轴",
  extracting: "提取音轨",
  loading_model: "加载模型",
  separating: "分离人声",
  saving_audio: "保存人声",
  remuxing: "合成视频",
  muting: "移除音轨",
  compressing: "压缩视频",
  authorizing: "验证账号",
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
  compact = false,
}: {
  task: YoutubeTask;
  open?: () => void;
  showError?: boolean;
  compact?: boolean;
}) {
  const progress =
    task.progress ??
    (task.status === "processing"
      ? { stage: "preparing", message: "正在启动处理进程，等待阶段信息" }
      : null);
  const active = youtubeActiveStatuses.includes(task.status);
  const showDetails = active || task.status === "paused" || task.status === "failed";
  const percent = youtubeTaskPercent(task);
  const elapsed = youtubeTaskElapsed(task);
  const showProgress = showDetails;
  const transfer =
    typeof progress?.transferredBytes === "number" &&
    Number.isFinite(progress.transferredBytes) &&
    progress.transferredBytes >= 0 &&
    typeof progress?.totalBytes === "number" &&
    Number.isFinite(progress.totalBytes) &&
    progress.totalBytes > 0
      ? `${youtubeBytes(progress.transferredBytes)} / ${youtubeBytes(progress.totalBytes)}`
      : undefined;
  const speed = youtubeSpeed(progress?.speedText);
  const failure = youtubeTaskFailure(task);
  const stage =
    progress?.stage && showDetails
      ? `${youtubeStageLabels[progress.stage] ?? "处理中"}${progress.episodeIndex && progress.episodeCount ? ` ${progress.episodeIndex}/${progress.episodeCount} 集` : ""}`
      : "";
  const stalled = active && (progress?.lastAdvanceSeconds ?? 0) >= 30;
  if (compact) {
    const label = task.status === "failed" ? (failure?.title ?? "处理失败") : stage;
    const secondary = stalled
      ? "进度暂无变化"
      : progress?.stage === "downloading"
        ? speed
        : progress?.etaText
          ? `剩余 ${progress.etaText}`
          : undefined;
    return (
      <div
        className="min-w-0 text-xs"
        title={[
          stage,
          failure ? `${failure.reason}\n${failure.action}` : progress?.message,
          transfer,
          speed,
          progress?.etaText,
          stalled ? `已 ${Math.floor(progress!.lastAdvanceSeconds!)} 秒未推进` : "",
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <div className="flex h-5 min-w-0 items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate ${task.error ? "text-destructive" : "text-muted-foreground"}`}
          >
            {label || "—"}
          </span>
          {showProgress && percent !== null && (
            <span className="shrink-0 tabular-nums">{Number(percent.toFixed(1))}%</span>
          )}
        </div>
        {((showProgress && percent !== null) || secondary) && (
          <div className="mt-1 flex h-4 min-w-0 items-center gap-2">
            {showProgress && percent !== null && (
              <div
                role="progressbar"
                aria-label={`${task.payload.resourceName}当前阶段进度`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1 min-w-4 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
              </div>
            )}
            {secondary && (
              <span
                className={`truncate tabular-nums ${stalled ? "text-[var(--youtube-warning-text)]" : "text-muted-foreground"}`}
              >
                {secondary}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <YoutubeTaskStatus status={task.status} />
        {showProgress && percent !== null && (
          <span
            className="tabular-nums text-muted-foreground"
            title={task.status === "completed" ? "任务已完成" : "当前阶段进度"}
          >
            {Number(percent.toFixed(1))}%
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
      {progress?.stage && showDetails && <p className="mt-1.5 font-medium">{stage}</p>}
      {showDetails && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {elapsed !== undefined && Number.isFinite(elapsed) && (
            <span>耗时 {youtubeDuration(elapsed)}</span>
          )}
          {transfer && <span>{transfer}</span>}
          {speed && progress?.stage === "downloading" && <span>{speed}</span>}
          {progress?.etaText && (
            <span>
              {progress.etaScope === "item" ? "本集剩余" : "预计剩余"} {progress.etaText}
            </span>
          )}
          {progress?.totalItems && !progress.episodeIndex ? (
            <span>
              {progress.completedItems ?? 0} / {progress.totalItems} 项
            </span>
          ) : null}
        </div>
      )}
      {active && (progress?.lastAdvanceSeconds ?? 0) >= 30 && (
        <p className="mt-1 text-[var(--youtube-warning-text)]">进度暂无变化</p>
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
