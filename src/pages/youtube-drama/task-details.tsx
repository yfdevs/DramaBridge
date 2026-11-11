import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CodeOutput } from "@/components/code-output";
import { useWorkspacePageActive } from "@/components/workspace-toolbar";
import { youtubeService, type YoutubeTask } from "@/platforms/youtube-drama/service";
import { youtubeModeLabels } from "./task-status";
import { YoutubeTaskProgress, youtubeDuration, youtubeStageLabels } from "./task-progress";

export function YoutubeTaskDetails({
  task,
  running,
  onClose,
}: {
  task: YoutubeTask | null;
  running: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<YoutubeTask | null>(null);
  const [error, setError] = useState("");
  const id = task?.id;
  const active = useWorkspacePageActive();
  useEffect(() => {
    setDetail(null);
    setError("");
    if (!id || !running || !active) return;
    let disposed = false,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await youtubeService.request<YoutubeTask>(
          `/api/tasks/${encodeURIComponent(id)}`,
        );
        if (!disposed) {
          setDetail(next);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id, running, active]);
  const current = detail?.id === id ? detail : task;
  return (
    <Sheet
      open={Boolean(task)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="youtube-theme gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl duration-250 ease-out motion-reduce:transition-none">
        <SheetHeader className="border-b p-5 pr-12">
          <SheetTitle className="break-words text-lg">{task?.payload.resourceName}</SheetTitle>
          <SheetDescription>
            {running ? "任务详情，自动更新" : "任务详情，服务已停止"}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {current && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-5 gap-y-3 pb-4 text-sm">
              <dt className="text-muted-foreground">状态</dt>
              <dd>
                <YoutubeTaskProgress task={current} showError={false} />
              </dd>
              <dt className="text-muted-foreground">处理方式</dt>
              <dd>{youtubeModeLabels[current.payload.mode ?? "merge"] ?? current.payload.mode}</dd>
              <dt className="text-muted-foreground">上传标题</dt>
              <dd className="break-words">
                {current.payload.title || current.payload.resourceName}
              </dd>
              <dt className="text-muted-foreground">任务编号</dt>
              <dd className="break-all font-mono text-xs leading-5">{current.id}</dd>
            </dl>
          )}
          {current?.timings?.stages && Object.keys(current.timings.stages).length > 0 && (
            <section aria-label="阶段耗时" className="space-y-3">
              <h3 className="text-sm font-semibold">阶段耗时</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                {Object.entries(current.timings.stages).map(([stage, timing]) => (
                  <div key={stage} className="flex min-w-0 items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{youtubeStageLabels[stage] ?? stage}</dt>
                    <dd className="tabular-nums">
                      {youtubeDuration(timing.elapsedSeconds)}
                      {timing.lastOutcome === "interrupted"
                        ? "（中断）"
                        : timing.lastOutcome === "failed"
                          ? "（失败）"
                          : ""}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {error && (
            <p role="alert" className="break-words text-xs text-destructive">
              读取日志失败：{error}
            </p>
          )}
          {current?.error && (
            <p
              role="alert"
              className="rounded-md bg-[var(--youtube-error-bg)] p-3 text-sm leading-6 text-destructive break-words"
            >
              {current.error}
            </p>
          )}
          <CodeOutput
            title="执行日志"
            value={
              (detail?.id === id && detail?.logs) ||
              (detail?.id === id
                ? "暂无执行日志"
                : running && !error
                  ? "正在读取日志…"
                  : "暂无日志")
            }
          />
          {detail?.id === id && detail?.result != null && (
            <CodeOutput title="处理结果" value={JSON.stringify(detail.result, null, 2)} />
          )}
        </div>
        <div className="flex justify-end border-t p-4">
          <Button size="sm" variant="outline" onClick={onClose}>
            关闭详情
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
