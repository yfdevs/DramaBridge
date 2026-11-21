import type { YoutubeTask } from "@/platforms/youtube-drama/service";
import { youtubeStageLabels } from "./task-progress";
import { youtubeTaskPercent } from "./task-progress-data";
import { youtubeTaskFailure } from "./task-failure";

export function YoutubeWebTaskProgress({ task }: { task: YoutubeTask }) {
  const percent = youtubeTaskPercent(task);
  const progress = task.progress;
  const episodeCount = task.result?.episodeCount;
  const label = task.status === "completed" ? "已完成"
    : task.status === "failed" ? youtubeTaskFailure(task)?.title ?? "处理失败"
    : task.status === "queued" ? "等待执行"
    : youtubeStageLabels[progress?.stage ?? ""] ?? "等待进度";
  const episode = task.payload.mode === "episodes" && episodeCount
    ? `已${task.payload.noUpload ? "处理" : "上传"} ${task.result?.completedEpisodes ?? 0}/${episodeCount} 集`
    : progress?.episodeIndex && progress.episodeCount ? `第 ${progress.episodeIndex}/${progress.episodeCount} 集` : "";
  return (
    <div className="flex h-6 min-w-0 items-center gap-2" title={[label, episode, progress?.message, progress?.etaText && `剩余 ${progress.etaText}`].filter(Boolean).join("\n")}>
      <span className={`min-w-0 flex-1 truncate ${task.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
        {episode || label}
      </span>
      <div role="progressbar" aria-label={`${task.payload.resourceName}当前阶段进度`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
        className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
        {percent !== null && <div className="h-full bg-primary" style={{ width: `${percent}%` }} />}
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
        {percent === null ? "—" : `${Number(percent.toFixed(1))}%`}
      </span>
    </div>
  );
}

export function youtubeWebCreatedTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
