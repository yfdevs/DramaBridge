import type { YoutubeTask } from "@/platforms/youtube-drama/service";
import { youtubeTaskFailure } from "./task-failure";
import { youtubeStageLabels } from "./task-progress";

export function YoutubeWebTaskFailure({ task }: { task: YoutubeTask }) {
  if (task.status !== "failed") return null;
  const failure = task.progress?.failure ?? youtubeTaskFailure(task);
  const messages = [...new Set([failure?.reason, failure?.action, task.error, failure?.detail]
    .filter((value): value is string => Boolean(value?.trim())))];
  return (
    <section aria-label={`${task.payload.resourceName}失败详情`}
      className="min-w-0 space-y-2 rounded-md bg-[var(--youtube-error-bg)] px-3 py-3 text-xs leading-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium text-destructive">{failure?.title ?? "任务失败"}</h3>
        <span className="text-muted-foreground">
          {[failure?.stage && `阶段：${youtubeStageLabels[failure.stage] ?? failure.stage}`,
            failure?.code && `类型：${failure.code}`,
            failure?.exitCode !== undefined && `退出码：${failure.exitCode}`].filter(Boolean).join(" · ")}
        </span>
      </div>
      {messages.length ? messages.map((message, index) => (
        <p key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message}</p>
      )) : <p>该任务未记录具体错误原因，请查看任务详情或重试</p>}
    </section>
  );
}
