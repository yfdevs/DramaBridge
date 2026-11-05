import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CircularProgress } from "@/components/ui/circular-progress";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import type { FeishuTaskService } from "@/platforms/feishu/task-service";
import type { FeishuRunnerState, RecreationTask } from "@/platforms/feishu/task-types";

export function taskPercent(task: RecreationTask) {
  const completed = task.results.filter((version) => version.shareUrl).length;
  const partial =
    completed < task.results.length && task.progress?.total
      ? Math.min(1, Math.max(0, task.progress.completed / task.progress.total))
      : 0;
  return task.results.length ? ((completed + partial) / task.results.length) * 100 : 0;
}

export function FeishuTaskCard({ state }: { state: FeishuRunnerState }) {
  const task = state.current;
  if (!task)
    return (
      <div
        className="rounded-lg border border-dashed px-5 py-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        {state.running ? "等待新任务" : "暂无处理中的任务"}
      </div>
    );
  const failed = task.state === "failed";
  const phase = failed
    ? "失败"
    : state.phase === "writing"
      ? "回写中"
      : task.state === "completed"
        ? "已完成"
        : state.stopping
          ? "正在停止"
          : state.running && state.phase === "processing"
            ? "处理中"
            : "已暂停";
  return (
    <section aria-label="当前剧目进度" className="flex items-center gap-4 rounded-lg border p-4">
      <CircularProgress
        value={taskPercent(task)}
        label={`${task.originalTitle}处理进度`}
        failed={failed}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-sm font-semibold">{task.originalTitle}</h2>
          <Badge variant={failed ? "destructive" : "secondary"} className="shrink-0 text-xs">
            {phase}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {Number.isFinite(task.episodeCount)
            ? `${task.episodeCount} 集 · 转存 ${task.downloadCount} 集`
            : "集数待修正"}
          {task.results.length > 1 &&
            ` · 版本 ${task.results.filter((v) => v.shareUrl).length}/${task.results.length}`}
        </p>
        <p
          role="status"
          className={
            failed
              ? "break-words text-xs leading-5 text-destructive"
              : "break-words text-xs leading-5 text-muted-foreground"
          }
        >
          {failed
            ? task.message
            : state.phase === "writing"
              ? "正在回写链接…"
              : task.state === "completed"
                ? task.message
                : task.progress
                  ? `${task.progress.stage} ${task.progress.completed}/${task.progress.total} 集`
                  : "等待网盘处理…"}
        </p>
      </div>
    </section>
  );
}

export function FeishuTaskMonitorPage({
  service,
  label,
}: {
  service: FeishuTaskService;
  label: string;
}) {
  const [state, setState] = useState<FeishuRunnerState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await service.workspace();
        if (alive) setState(next);
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const unsubscribe = service.onChanged(() => void refresh());
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [service]);
  const action = async () => {
    setBusy(true);
    setError("");
    try {
      setState(await (state?.running ? service.pause() : service.start()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const status = !state
    ? "加载中"
    : state.stopping
      ? "正在停止"
      : state.phase === "error"
        ? "连接异常"
        : !state.running
          ? "未运行"
          : {
              idle: "待处理",
              reading: "读取中",
              waiting: "等待任务",
              processing: "处理中",
              writing: "回写中",
            }[state.phase];
  return (
    <main className="flex h-full min-h-0 flex-col overflow-auto">
      <WorkspaceActions label={`${label}操作`}>
        <Badge variant={state?.phase === "error" ? "destructive" : "secondary"}>{status}</Badge>
        <Button size="sm" disabled={!state || busy || state.stopping} onClick={() => void action()}>
          {state?.stopping || (busy && state?.running)
            ? "正在停止…"
            : busy
              ? "启动中…"
              : state?.running
                ? "停止处理"
                : "开始处理"}
        </Button>
      </WorkspaceActions>
      <div className="flex w-full max-w-2xl flex-col gap-3 p-5">
        {(error || state?.error) && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {error || state?.error}
          </p>
        )}
        <FeishuTaskCard
          state={
            state ?? {
              running: false,
              stopping: false,
              phase: "idle",
              message: "",
              completed: 0,
              failed: 0,
            }
          }
        />
        <footer aria-label="处理统计" className="flex gap-4 px-1 text-xs text-muted-foreground">
          <span>已完成 {state?.completed ?? 0}</span>
          <span className={state?.failed ? "text-destructive" : undefined}>
            失败 {state?.failed ?? 0}
          </span>
        </footer>
      </div>
    </main>
  );
}
