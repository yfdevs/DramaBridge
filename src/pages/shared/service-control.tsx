import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Chrome, Play, StopCircle, CheckCircle, Cog, ChevronRight } from "@mynaui/icons-react";
import { NavLink, useLocation } from "react-router-dom";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { platformForPath, routePath } from "@/config/navigation";
import { formatRuntimeDuration, useAppRuntime } from "@/platforms/app-runtime/context";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskAnalyticsPlatform } from "@/platforms/task-analytics/service";
import { TaskStatisticsChart } from "./task-statistics-chart";

type RuntimeStatus = {
  running: boolean;
};

const GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE = "GLOBAL_APP_DIRECTORIES_REQUIRED";

function globalDirectoriesWarning(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const markerIndex = message.indexOf(GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE);
  if (markerIndex < 0) return null;

  return message
    .slice(markerIndex + GLOBAL_DIRECTORIES_REQUIRED_ERROR_CODE.length)
    .replace(/^\s*:\s*/, "")
    .trim();
}

type RuntimeService<TStatus extends RuntimeStatus> = {
  status: () => Promise<TStatus>;
  start: () => Promise<TStatus>;
  stop: () => Promise<TStatus>;
};

export function useServiceControl<TStatus extends RuntimeStatus>({
  initialStatus,
  service,
  successMessage,
}: {
  initialStatus: TStatus;
  service: RuntimeService<TStatus>;
  successMessage: (status: TStatus) => string;
}) {
  const [status, setStatus] = useState<TStatus>(initialStatus);
  const [pendingAction, setPendingAction] = useState<"start" | "stop" | null>(null);
  const statusRefreshInFlightRef = useRef(false);

  const applyStatus = (nextStatus: TStatus) => {
    setStatus(nextStatus);
  };

  const refreshStatus = useCallback(
    async (silent = false) => {
      if (statusRefreshInFlightRef.current) return;

      statusRefreshInFlightRef.current = true;

      try {
        applyStatus(await service.status());
      } catch (error) {
        if (!silent) {
          toast.error("状态刷新失败", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        statusRefreshInFlightRef.current = false;
      }
    },
    [service],
  );

  const toggleService = useCallback(async () => {
    if (pendingAction) return;

    const action = status.running ? "stop" : "start";
    setPendingAction(action);

    try {
      const nextStatus = await (status.running ? service.stop() : service.start());
      applyStatus(nextStatus);
      toast.success(successMessage(nextStatus));
    } catch (error) {
      const directoryWarning = action === "start" ? globalDirectoriesWarning(error) : null;
      if (directoryWarning !== null) {
        toast.warning("文件与目录未配置", {
          description: directoryWarning,
        });
      } else {
        toast.error("操作失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setPendingAction(null);
      window.dispatchEvent(new Event("app:service-changed"));
    }
  }, [pendingAction, service, status.running, successMessage]);

  useEffect(() => {
    if (!window.ipcRenderer) return;
    void refreshStatus();

    const statusRefreshInterval = window.setInterval(() => {
      void refreshStatus(true);
    }, 3000);

    return () => {
      window.clearInterval(statusRefreshInterval);
    };
  }, [refreshStatus]);

  return {
    loading: pendingAction !== null,
    pendingAction,
    refreshStatus,
    status,
    toggleService,
  };
}

export function ServiceControlButtonPage({
  loading,
  pendingAction,
  running,
  startLabel = "启动服务",
  stopLabel = "关闭服务",
  additionalAction,
  analyticsPlatform,
  onToggle,
}: {
  loading: boolean;
  pendingAction: "start" | "stop" | null;
  running: boolean;
  startLabel?: string;
  stopLabel?: string;
  additionalAction?: ReactNode;
  analyticsPlatform?: TaskAnalyticsPlatform;
  onToggle: () => void;
}) {
  const location = useLocation();
  const platform = platformForPath(
    analyticsPlatform ? `${analyticsPlatform}/service` : location.pathname.replace(/^\/+/, ""),
  );
  const { entries, now } = useAppRuntime();
  const runtime = entries[platform.id]?.result?.platform;
  const entry = entries[platform.id];
  const connected = Boolean(window.ipcRenderer);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const label =
    pendingAction === "start"
      ? "正在启动…"
      : pendingAction === "stop"
        ? "正在停止…"
        : running
          ? stopLabel
          : startLabel;
  return (
    <main className="service-workspace flex min-h-full flex-col">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-6 py-2">
        <span className="text-xs text-muted-foreground">
          {loading ? "正在处理服务…" : running ? "运行中" : "未启动"}
          {running && (
            <span className="ml-2 font-mono tabular-nums">
              {formatRuntimeDuration(runtime?.startedAt, now)}
            </span>
          )}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {additionalAction}
          <Button
            aria-busy={loading}
            aria-pressed={running}
            className="h-7 gap-1.5 px-3 text-xs"
            disabled={loading || !connected}
            variant={running ? "secondary" : "default"}
            onClick={onToggle}
          >
            {running ? <StopCircle className="size-3.5" /> : <Play className="size-3.5" />}
            <span>{label}</span>
          </Button>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[920px] flex-1 flex-col px-7 pt-10 pb-8 md:px-12 md:pt-14">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              loading ? "bg-amber-600" : running ? "bg-emerald-600" : "bg-muted-foreground/45",
            )}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h1 className="text-[16px] font-semibold leading-6 tracking-normal">
              {!connected
                ? "等待连接桌面服务"
                : entry?.error
                  ? "暂时无法读取服务状态"
                  : loading
                    ? pendingAction === "start"
                      ? "正在启动服务…"
                      : "正在停止服务…"
                    : running
                      ? `${platform.title}服务正在运行`
                      : `${platform.title}服务尚未启动`}
            </h1>
            <p className="mt-2 max-w-[60ch] text-[13px] leading-6 text-muted-foreground">
              {!connected
                ? "在 AutoDrama 桌面端打开此工作空间，即可启动自动化服务。"
                : entry?.error
                  ? entry.error
                  : running
                    ? "自动化任务将按当前平台配置执行。"
                    : "确认平台配置后，点击右上角的“启动服务”开始运行。"}
            </p>
            {running && (
              <p className="mt-4 text-xs text-muted-foreground">
                已运行{" "}
                <span className="font-mono tabular-nums">
                  {formatRuntimeDuration(runtime?.startedAt, now)}
                </span>
                <span className="mx-2">·</span>
                {runtime?.browserInstanceCount ?? 0} 个浏览器实例
              </p>
            )}
            {!running && (
              <Button
                className="mt-3 h-7 gap-1.5 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                variant="ghost"
                render={<NavLink to={routePath(platform.configRoute)} />}
              >
                <Cog className="size-3.5" />
                查看平台配置
                <ChevronRight className="size-3" />
              </Button>
            )}
          </div>
        </div>
        <section aria-label="浏览器连接" className="mt-10">
          <div className="mb-5 flex items-center gap-3 text-[13px] font-medium">
            <Chrome className="size-4 text-muted-foreground" />
            <h2>浏览器实例</h2>
            <span className="font-normal text-muted-foreground">
              {runtime?.browserInstanceCount ?? 0}
            </span>
          </div>
          {runtime?.browserInstances.length ? (
            <div className="ml-7 space-y-5">
              {runtime.browserInstances.map((instance) => (
                <div key={instance.id} className="flex items-start gap-3">
                  <CheckCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <span className="text-[13px] font-medium">{instance.label}</span>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {instance.loginState === "logged-in"
                        ? "已登录 · 浏览器已连接"
                        : instance.loginState === "login-required"
                          ? "等待登录，请在浏览器中完成登录"
                          : "浏览器已连接"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="ml-7 text-[13px] leading-6 text-muted-foreground">
              {running ? "等待浏览器连接…" : "服务启动后，浏览器连接会显示在这里。"}
            </p>
          )}
        </section>
        {analyticsPlatform && (
          <Collapsible open={statisticsOpen} onOpenChange={setStatisticsOpen} className="mt-10">
            <CollapsibleTrigger className="group flex items-center gap-2 rounded py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
              <span>近 30 天发布统计</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <TaskStatisticsChart platform={analyticsPlatform} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <footer className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t border-border/60 px-6 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-emerald-600" : "bg-muted-foreground/45",
            )}
          />
          {connected ? "本地服务已连接" : "桌面服务未连接"}
        </span>
        <span>
          AutoDrama<span className="mx-2">·</span>
          {platform.title}
        </span>
      </footer>
    </main>
  );
}
