import { Badge } from "@/components/ui/badge";

export const youtubeTaskLabels: Record<string, string> = {
  queued: "排队中",
  downloading: "下载中",
  processing: "处理中",
  uploading: "上传中",
  waiting: "等待恢复",
  completed: "已完成",
  paused: "已暂停",
  failed: "失败",
  cancelled: "已取消",
};

export const youtubeModeLabels: Record<string, string> = {
  merge: "合并人声版",
  mute: "合并静音版",
  episodes: "逐集分离（已停用）",
};

export const youtubeActiveStatuses = ["downloading", "processing", "uploading", "waiting"];

export function YoutubeTaskStatus({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "bg-[var(--youtube-success-bg)] text-[var(--youtube-success-text)]"
      : status === "failed"
        ? "bg-[var(--youtube-error-bg)] text-destructive"
        : ["paused", "waiting"].includes(status)
          ? "bg-[var(--youtube-warning-bg)] text-[var(--youtube-warning-text)]"
          : "bg-muted text-foreground";
  return (
    <Badge variant="secondary" className={`text-xs ${color}`}>
      {youtubeTaskLabels[status] ?? status}
    </Badge>
  );
}
