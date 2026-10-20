import { Chrome, CircleDashed, Cog, Globe, Info } from "@mynaui/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AppUpdateControl } from "@/components/app-update-control";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  defaultRoute,
  globalConfigRoute,
  isAppRoute,
  platformForPath,
  routePath,
} from "@/config/navigation";
import { cn } from "@/lib/utils";
import {
  getAppPlatformRuntime,
  openAppPlatformLogs,
  type AppPlatformRuntimeResult,
} from "@/platforms/app-runtime/service";

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function platformStateLabel(result: AppPlatformRuntimeResult | null) {
  if (!result) return "读取中";
  return result.platform.running ? "运行中" : "未启动";
}

function platformStateClass(result: AppPlatformRuntimeResult | null) {
  if (!result) return "bg-muted-foreground/50";
  return result.platform.running ? "bg-emerald-500" : "bg-muted-foreground/45";
}

function browserSummary(result: AppPlatformRuntimeResult | null) {
  if (!result) return "浏览器实例读取中";

  const count = result.platform.browserInstanceCount;
  if (count <= 0) return "当前平台没有运行中的浏览器实例";

  return `${count} 个浏览器实例`;
}

export function AppRuntimeDock() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.replace(/^\/+/, "");
  const activeRoute = isAppRoute(currentPath) ? currentPath : defaultRoute;
  const activePlatform = platformForPath(activeRoute);
  const visible = activeRoute === activePlatform.serviceRoute;
  const [runtime, setRuntime] = useState<AppPlatformRuntimeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingLogs, setOpeningLogs] = useState(false);

  const visibleInstances = useMemo(
    () => runtime?.platform.browserInstances.slice(0, 3) ?? [],
    [runtime],
  );
  const hiddenInstanceCount = Math.max(
    0,
    (runtime?.platform.browserInstanceCount ?? 0) - visibleInstances.length,
  );

  useEffect(() => {
    if (!window.ipcRenderer || !visible) return;

    let disposed = false;

    const refresh = async () => {
      try {
        const nextRuntime = await getAppPlatformRuntime(activePlatform.id);
        if (!disposed) {
          setRuntime(nextRuntime);
          setError(null);
        }
      } catch (nextError) {
        if (!disposed) {
          setRuntime(null);
          setError(readableError(nextError));
        }
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 3000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [activePlatform.id, visible]);

  if (!window.ipcRenderer || !visible) {
    return null;
  }

  const versionText = runtime?.appVersion ? `v${runtime.appVersion}` : "v--";
  const stateLabel = platformStateLabel(runtime);
  const activeLogDir = runtime?.platform.logDir;

  const handleOpenLogs = () => {
    void (async () => {
      setOpeningLogs(true);
      setError(null);

      try {
        await openAppPlatformLogs(activePlatform.id);
      } catch (nextError) {
        setError(readableError(nextError));
      } finally {
        setOpeningLogs(false);
      }
    })();
  };

  return (
    <aside
      aria-label="当前平台运行状态"
      className="fixed right-2 bottom-2 z-30 flex max-w-[calc(100vw-1rem)] items-center gap-1 text-xs text-foreground [-webkit-app-region:no-drag]"
    >
      <Tooltip>
        <TooltipTrigger
          type="button"
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-background/90 px-1.5 text-left  outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="relative grid size-5 shrink-0 place-items-center rounded-sm">
            <img
              src={activePlatform.logoSrc}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="size-4 object-contain"
            />
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background",
                platformStateClass(runtime),
              )}
              aria-hidden="true"
            />
          </span>
          <span className="flex min-w-0 items-center gap-1">
            <span className="max-w-20 truncate font-medium leading-none">
              {activePlatform.title}
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              /
            </span>
            <span className="shrink-0 text-muted-foreground">{stateLabel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" sideOffset={8} className="grid max-w-72 gap-1.5">
          <span className="font-medium">{activePlatform.title}</span>
          <span className="text-background/70">
            {stateLabel} · DramaBridge {versionText}
          </span>
          {activeLogDir ? (
            <span className="break-all text-background/70">日志目录：{activeLogDir}</span>
          ) : null}
          {error ? <span className="text-background">{error}</span> : null}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          type="button"
          className="flex h-7 items-center gap-1 px-1.5 text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={browserSummary(runtime)}
        >
          {visibleInstances.length > 0 ? (
            <span className="flex items-center -space-x-1">
              {visibleInstances.map((instance) => (
                <span
                  key={instance.id}
                  className="grid size-4 place-items-center rounded-sm bg-secondary text-sky-600"
                  title={instance.label}
                >
                  <Chrome className="size-3" aria-hidden="true" />
                </span>
              ))}
              {hiddenInstanceCount > 0 ? (
                <span className="grid h-4 min-w-4 place-items-center rounded-sm border border-background bg-secondary px-0.5 text-[10px] font-medium text-foreground">
                  +{hiddenInstanceCount}
                </span>
              ) : null}
            </span>
          ) : (
            <Chrome className="size-3.5 text-muted-foreground/70" aria-hidden="true" />
          )}
          <span className="font-medium tabular-nums">
            {runtime?.platform.browserInstanceCount ?? 0}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="grid max-w-64 gap-1">
          <span>{browserSummary(runtime)}</span>
          {visibleInstances.map((instance) => (
            <span key={instance.id} className="truncate text-background/70">
              {instance.label}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>

      <AppUpdateControl />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="xs" variant="ghost" disabled={openingLogs} onClick={handleOpenLogs} />
          }
        >
          <CircleDashed className="size-3.5 text-yellow-500" aria-hidden="true" />
          <span>{openingLogs ? "打开中…" : "日志目录"}</span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" sideOffset={8}>
          打开{activePlatform.title}日志目录
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="打开全局配置"
              size="xs"
              variant="ghost"
              onClick={() => navigate(routePath(globalConfigRoute), {
                state: { returnRoute: activeRoute },
              })}
            />
          }
        >
          <Globe className="size-3.5" aria-hidden="true" />
          <span>全局配置</span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" sideOffset={8}>
          打开全局配置
        </TooltipContent>
      </Tooltip>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => navigate(routePath(activePlatform.configRoute))}
            />
          }
        >
          <Cog className="size-3.5" aria-hidden="true" />
          <span>配置</span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" sideOffset={8}>
          打开{activePlatform.title}配置
        </TooltipContent>
      </Tooltip>

      {error ? (
        <Tooltip>
          <TooltipTrigger
            type="button"
            className="grid size-6 place-items-center rounded-md text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={error}
          >
            <Info className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="top" align="end" sideOffset={8} className="max-w-72">
            {error}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </aside>
  );
}
