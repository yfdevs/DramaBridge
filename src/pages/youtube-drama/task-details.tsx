import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useWorkspacePageActive } from "@/components/workspace-toolbar";
import { youtubeService, type YoutubeTask } from "@/platforms/youtube-drama/service";

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
      <SheetContent className="w-full gap-0 sm:max-w-2xl motion-reduce:transition-none">
        <SheetHeader className="border-b p-5 pr-12">
          <SheetTitle className="break-words">{task?.payload.resourceName} · 执行详情</SheetTitle>
          <SheetDescription>
            查看任务日志与处理结果{running ? "，内容自动更新。" : "。服务已停止。"}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {error && (
            <p role="alert" className="break-words text-xs text-destructive">
              读取日志失败：{error}
            </p>
          )}
          {current?.error && (
            <p className="rounded-lg bg-destructive/10 p-3 text-xs leading-5 text-destructive">
              {current.error}
            </p>
          )}
          <h3 className="text-xs font-medium">执行日志</h3>
          <pre className="min-h-48 whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-4 text-xs leading-6">
            {(detail?.id === id && detail?.logs) ||
              (detail?.id === id
                ? "暂无执行日志"
                : running && !error
                  ? "正在读取日志…"
                  : "暂无日志")}
          </pre>
          {detail?.id === id && detail?.result != null && (
            <>
              <h3 className="text-xs font-medium">处理结果</h3>
              <pre className="whitespace-pre-wrap break-all rounded-lg border p-4 text-xs leading-6">
                {JSON.stringify(detail.result, null, 2)}
              </pre>
            </>
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
