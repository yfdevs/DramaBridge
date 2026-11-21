import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { managementContentClass } from "@/pages/shared/management-layout";
import { ManagementListSkeleton } from "@/pages/shared/management-skeleton";
import { useNotification } from "@/hooks/use-notification";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Progress } from "@/components/ui/progress";
import { CheckCircleIcon, CircleAlertIcon, CircleIcon, StopCircleIcon } from "@/components/ui/solar-icons";
import { Spinner } from "@/components/ui/spinner";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import type { FeishuTaskService } from "@/platforms/feishu/task-service";
import type { FeishuRunnerState } from "@/platforms/feishu/task-types";

const taskSteps = ["检查任务", "整理并转存素材", "生成分享链接", "回写飞书"];

function taskStep(task: NonNullable<FeishuRunnerState["current"]>) {
  if (task.state === "completed") return 3;
  if (task.progress?.stage.includes("生成分享链接")) return 2;
  if (task.progress || task.state === "uploading" || task.state === "processing") return 1;
  if (task.state !== "failed") return 0;
}

export function FeishuTaskCard({ state }: { state: FeishuRunnerState }) {
  const task = state.current;
  if (!task)
    return (
      <EmptyStateCard
        title={state.running ? "等待新任务" : "暂无处理中的任务"}
        description={state.message || undefined}
      />
    );

  const failed = task.state === "failed";
  const writebackDone = task.state === "completed" && task.message === "链接已回写飞书" && state.phase !== "writing";
  const progress = task.progress;
  const linkReady = task.state === "completed";
  const currentStep = writebackDone ? undefined : taskStep(task);
  const completedSteps = writebackDone ? taskSteps.length : currentStep ?? 0;
  const stepFailed = failed || (linkReady && !writebackDone && state.phase === "error");
  const processing =
    !stepFailed && (state.phase === "writing" || (state.running && state.phase === "processing"));
  const phase = stepFailed
    ? "失败"
    : state.stopping
      ? "正在停止"
      : writebackDone
        ? "已完成"
        : processing
          ? state.phase === "writing" ? "回写中" : "处理中"
          : "已暂停";
  const detail = failed
    ? task.message
    : stepFailed
      ? state.error || state.message
      : state.phase === "writing"
        ? state.message
        : progress
          ? `${progress.stage}${progress.total > 0 ? ` · ${progress.completed}/${progress.total} 集` : ""}`
          : task.message;

  return (
    <section aria-label="当前剧目进度" className="min-w-0 space-y-3 rounded-lg border border-dashed border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="break-words text-sm font-medium">{task.originalTitle}</h2>
          <p className="text-xs text-muted-foreground">
            {Number.isFinite(task.episodeCount)
              ? `共 ${task.episodeCount} 集 · 计划转存 ${task.downloadCount} 集`
              : "集数待修正"}
            {task.results.length > 1 &&
              ` · 已生成 ${task.results.filter((version) => version.shareUrl).length}/${task.results.length} 个版本链接`}
          </p>
        </div>
        <Badge variant={stepFailed ? "destructive" : "secondary"} className="shrink-0 text-xs">
          {phase}
        </Badge>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">任务步骤</span>
          <span className="tabular-nums text-muted-foreground">已完成 {completedSteps}/{taskSteps.length} 步</span>
        </div>
        <Progress
          aria-label="任务步骤"
          aria-valuetext={`已完成 ${completedSteps}/${taskSteps.length} 步`}
          value={completedSteps}
          max={taskSteps.length}
        />
      </div>

      <ol className="space-y-2">
        {taskSteps.map((label, index) => {
          const complete = index < completedSteps;
          const current = index === currentStep;
          const error = current && stepFailed;
          const Icon = complete ? CheckCircleIcon : error ? CircleAlertIcon : current && processing ? Spinner : current ? StopCircleIcon : CircleIcon;
          return (
            <Marker
              key={label}
              render={<li />}
              aria-current={current ? "step" : undefined}
              className={cn(
                "items-start text-xs leading-5",
                current && "font-medium text-foreground",
              )}
            >
              <MarkerIcon className="mt-0.5">
                <Icon className={cn(
                  "size-4 motion-reduce:animate-none",
                  complete && "text-emerald-700 dark:text-emerald-400",
                  error && "text-destructive",
                )} />
              </MarkerIcon>
              <MarkerContent className="flex-1">
                {label}
                {current && detail && (
                  <span role="status" className={cn(
                    "mt-0.5 block w-fit max-w-full break-words font-normal",
                    error ? "text-destructive" : "text-muted-foreground",
                    processing && "motion-safe:shimmer",
                  )}>
                    {detail}
                  </span>
                )}
              </MarkerContent>
              {error ? (
                <Badge variant="destructive">失败</Badge>
              ) : (
                <span className="shrink-0 font-normal">
                  {complete ? "已完成" : current ? (processing ? "进行中" : "已暂停") : "待处理"}
                </span>
              )}
            </Marker>
          );
        })}
      </ol>
      {currentStep === undefined && detail && (
        <p role="status" className={cn("break-words text-xs", stepFailed ? "text-destructive" : "text-muted-foreground")}>{detail}</p>
      )}
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
  useNotification(error || state?.error, "error", "任务操作失败");
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
                ? "停止"
                : "开始"}
        </Button>
      </WorkspaceActions>
      <div className={managementContentClass}>
        <div data-skeleton-transition>
          {!state && !error ? (
            <ManagementListSkeleton label="正在读取任务进度" rows={2} />
          ) : <FeishuTaskCard
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
          />}
        </div>
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
