import { WorkspaceActions } from "@/components/workspace-toolbar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "@mynaui/icons-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { TaskAnalyticsPlatform } from "@/platforms/task-analytics/service";

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
  startDisabled = false,
  beforeBrowserInstances,
  children,
  onToggle,
}: {
  loading: boolean;
  pendingAction: "start" | "stop" | null;
  running: boolean;
  startLabel?: string;
  stopLabel?: string;
  additionalAction?: ReactNode;
  startDisabled?: boolean;
  beforeBrowserInstances?: ReactNode;
  children?: ReactNode;
  analyticsPlatform?: TaskAnalyticsPlatform;
  onToggle: () => void;
}) {
  const connected = Boolean(window.ipcRenderer);
  const label =
    pendingAction === "start"
      ? "正在启动…"
      : pendingAction === "stop"
        ? "正在停止…"
        : running
          ? stopLabel
          : startLabel;
  return (
    <main className="service-workspace flex min-h-full min-w-0 flex-col">
      <WorkspaceActions label="服务操作">
        <Button
          aria-busy={loading}
          aria-pressed={running}
          className="h-7 min-w-20 gap-1.5 px-3 text-xs"
          size="sm"
          disabled={loading || !connected || (!running && startDisabled)}
          variant={running ? "secondary" : "default"}
          onClick={onToggle}
        >
          <span>{label}</span>
        </Button>
        {additionalAction && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label="更多服务操作"
                />
              }
            >
              <ChevronDown className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-fit min-w-44 p-2 [&_button]:w-full [&_button]:justify-start [&_div]:flex-col"
            >
              {additionalAction}
            </PopoverContent>
          </Popover>
        )}
      </WorkspaceActions>
      <div className="mx-auto flex w-full min-w-0 max-w-[920px] flex-1 flex-col px-7 pt-4 pb-8 md:px-12 md:pt-4">
        {beforeBrowserInstances}
        {children}
      </div>
    </main>
  );
}
