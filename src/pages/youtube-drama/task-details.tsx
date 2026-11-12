import { useNotification } from "@/hooks/use-notification";
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { useWorkspacePageActive } from "@/components/workspace-toolbar";
import { youtubeService, type YoutubeTask } from "@/platforms/youtube-drama/service";
import { youtubeModeLabels } from "./task-status";
import { YoutubeTaskProgress, youtubeDuration, youtubeStageLabels } from "./task-progress";
import { youtubeTaskFailure } from "./task-failure";

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
  useNotification(error, "error", "详情读取失败", active && Boolean(id));
  useEffect(() => {
    setDetail(null);
    setError("");
    if (!id || !active) return;
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
  const failure = current ? youtubeTaskFailure(current) : null;
  return (
    <Sheet
      open={Boolean(task)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        showCloseButton={false}
        className="youtube-theme gap-0 shadow-none data-[side=right]:w-full data-[side=right]:sm:max-w-lg duration-250 ease-out motion-reduce:transition-none"
      >
        <SheetHeader className="shrink-0 border-b p-5">
          <SheetTitle className="break-words text-base">{task?.payload.resourceName}</SheetTitle>
          <SheetDescription className="sr-only">任务详情</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {current && (
            <>
              <section aria-label="任务进度" className="shrink-0">
                <YoutubeTaskProgress task={current} showError={false} />
              </section>
              <dl className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-5 gap-y-3 text-sm">
                <dt className="text-muted-foreground">处理方式</dt>
                <dd>
                  {youtubeModeLabels[current.payload.mode ?? "merge"] ?? current.payload.mode}
                </dd>
                {current.payload.accountName && !current.payload.noUpload && (
                  <>
                    <dt className="text-muted-foreground">上传账号</dt>
                    <dd>{current.payload.accountName}</dd>
                  </>
                )}
                {current.payload.title &&
                  current.payload.title !== current.payload.resourceName && (
                    <>
                      <dt className="text-muted-foreground">上传标题</dt>
                      <dd className="break-words">{current.payload.title}</dd>
                    </>
                  )}
              </dl>
            </>
          )}
          {failure && (
            <section
              role="alert"
              aria-label="失败原因"
              className="shrink-0 rounded-md bg-[var(--youtube-error-bg)] p-3 text-sm leading-6 text-foreground break-words"
            >
              <h3 className="font-medium text-destructive">{failure.title}</h3>
              <p className="mt-1">{failure.reason}</p>
              <p className="mt-2">{failure.action}</p>
              {failure.code.startsWith("AUTH_") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  nativeButton={false}
                  render={<Link to="/youtube-drama/accounts" />}
                  onClick={onClose}
                >
                  管理账号
                </Button>
              )}
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  错误详情
                </summary>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt>错误类型</dt>
                  <dd className="break-all">{failure.code}</dd>
                  {failure.stage && (
                    <>
                      <dt>失败阶段</dt>
                      <dd>{youtubeStageLabels[failure.stage] ?? failure.stage}</dd>
                    </>
                  )}
                  {failure.exitCode !== undefined && (
                    <>
                      <dt>退出代码</dt>
                      <dd>{failure.exitCode}</dd>
                    </>
                  )}
                </dl>
                {failure.detail && (
                  <p className="mt-2 whitespace-pre-wrap break-words">{failure.detail}</p>
                )}
              </details>
            </section>
          )}
          {current && (
            <details key={current.id} className="group shrink-0 border-t pt-4">
              <summary className="flex cursor-pointer list-none items-center justify-between rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                更多信息
                <ChevronDownIcon className="size-4 group-open:rotate-180" aria-hidden="true" />
              </summary>
              <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-xs">
                <dt className="text-muted-foreground">任务编号</dt>
                <dd className="break-all">{current.id}</dd>
                <dt className="text-muted-foreground">创建时间</dt>
                <dd>{new Date(current.created).toLocaleString("zh-CN", { hour12: false })}</dd>
                {Object.entries(current.timings?.stages ?? {})
                  .filter(([, timing]) => timing.elapsedSeconds >= 1)
                  .map(([stage, timing]) => (
                    <div key={stage} className="contents">
                      <dt className="text-muted-foreground">
                        {youtubeStageLabels[stage] ?? stage}
                      </dt>
                      <dd className="tabular-nums">{youtubeDuration(timing.elapsedSeconds)}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          )}
        </div>
        <div className="flex shrink-0 justify-end border-t p-4">
          <Button size="sm" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
