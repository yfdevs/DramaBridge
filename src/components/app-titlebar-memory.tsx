import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Chrome,
  CloudDownload,
  Grid,
  HardDrive,
  Scissors,
} from "@mynaui/icons-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getBaiduNetdiskStatus,
  type BaiduNetdiskCdpStatus,
} from "@/platforms/baidu-netdisk/service";
import { openBaiduNetdiskDialog } from "@/platforms/baidu-netdisk/dialog";
import { openJianyingDialog } from "@/platforms/jianying/dialog-controller";
import {
  getJianyingStatus,
  type JianyingStatus,
} from "@/platforms/jianying/service";

type AppRuntimeStatus = {
  browserInstanceCount: number;
  runningPlatformCount: number;
  totalPlatformCount: number;
  disk?: {
    dDrive: {
      mount: string;
      usedBytes: number;
      totalBytes: number;
      availableBytes: number;
      usedPercent: number;
    } | null;
  };
  memory: {
    systemUsedBytes: number;
    systemTotalBytes: number;
    systemUsedPercent: number;
  };
};

const titlebarMetricClass =
  "app-chrome-control inline-flex h-6 select-none items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none [-webkit-app-region:no-drag]";

const titlebarIconButtonClass =
  "app-chrome-control inline-flex size-6 cursor-pointer select-none items-center justify-center rounded-md [-webkit-app-region:no-drag]";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatPercent(percent: number | null) {
  if (percent === null || !Number.isFinite(percent)) {
    return "--";
  }

  return `${Math.round(Math.min(Math.max(percent, 0), 100))}%`;
}

function memoryIconClass(percent: number | null) {
  if (percent === null) {
    return "text-muted-foreground/70";
  }

  if (percent >= 90) {
    return "text-rose-500";
  }

  if (percent >= 75) {
    return "text-amber-500";
  }

  return "text-emerald-500";
}

function diskIconClass(percent: number | null) {
  if (percent === null) {
    return "text-muted-foreground/70";
  }

  if (percent >= 90) {
    return "text-rose-500";
  }

  if (percent >= 80) {
    return "text-amber-500";
  }

  return "text-cyan-500";
}

function runningPlatformIconClass(runningCount: number) {
  return runningCount > 0 ? "text-violet-500" : "text-muted-foreground/70";
}

function browserIconClass(browserInstanceCount: number) {
  return browserInstanceCount > 0 ? "text-sky-500" : "text-muted-foreground/70";
}

function baiduNetdiskIconClass(
  status: BaiduNetdiskCdpStatus | null,
  error: string | null,
) {
  if (error || (status && !status.ready)) {
    return "text-rose-500";
  }

  if (status?.ready) {
    return "text-emerald-500";
  }

  return "text-muted-foreground/70";
}

function baiduNetdiskSummary(status: BaiduNetdiskCdpStatus | null, error: string | null) {
  if (error) {
    return error;
  }

  if (!status) {
    return "读取中";
  }

  if (status.ready) {
    return "CDP 已连接";
  }

  if (!status.appRunning) {
    return "百度网盘未启动";
  }

  if (!status.cdpRunning) {
    return "未以 CDP 模式启动";
  }

  return status.message;
}

function jianyingIconClass(status: JianyingStatus | null, error: string | null) {
  if (!error && status?.appRunning && status.accessibilityPrepared) return "text-emerald-500";
  return "text-rose-500";
}

function jianyingSummary(status: JianyingStatus | null, error: string | null) {
  if (error) return error;
  if (!status) return "读取中";
  if (!status.installed || !status.pathValid) return "应用路径无效";
  if (status.appRunning && status.accessibilityPrepared) return "自动化可用";
  if (status.appRunning) return "不可操作，请重新启动";
  return "剪映未运行";
}

async function getAppRuntimeStatus() {
  if (!window.ipcRenderer) {
    throw new Error("应用运行状态仅在 Electron 应用内可用。");
  }

  return window.ipcRenderer.invoke("app:runtime:status") as Promise<AppRuntimeStatus>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ensureTitlebarMemoryHost() {
  const titlebar = document.querySelector<HTMLElement>(".cet-titlebar");

  if (!titlebar) {
    return null;
  }

  const existingHost = titlebar.querySelector<HTMLElement>("[data-app-titlebar-memory-host]");

  if (existingHost) {
    return existingHost;
  }

  const host = document.createElement("div");
  host.dataset.appTitlebarMemoryHost = "true";
  host.className = [
    "app-titlebar-memory-host absolute top-0 z-[100] flex h-(--app-titlebar-height) items-center [-webkit-app-region:no-drag]",
    "mac:right-[max(12px,var(--app-titlebar-right-reserve))] mac:left-auto mac:pr-0 mac:pl-1",
    "win:right-auto win:left-[max(12px,var(--app-titlebar-left-reserve))] win:pr-1",
    "linux:right-auto linux:left-[max(12px,var(--app-titlebar-left-reserve))] linux:pr-1",
  ].join(" ");
  titlebar.append(host);

  return host;
}

type TitlebarMetricProps = {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: ReactNode;
};

function TitlebarMetric({ ariaLabel, icon, label, value }: TitlebarMetricProps) {
  return (
    <span aria-label={ariaLabel} className={titlebarMetricClass}>
      {icon}
      <span className="font-medium text-muted-foreground max-[840px]:hidden">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  );
}

export function AppTitlebarMemory() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AppRuntimeStatus | null>(null);
  const [baiduStatus, setBaiduStatus] = useState<BaiduNetdiskCdpStatus | null>(null);
  const [baiduError, setBaiduError] = useState<string | null>(null);
  const [jianyingStatus, setJianyingStatus] = useState<JianyingStatus | null>(null);
  const [jianyingError, setJianyingError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;

    const mountHost = () => {
      const nextHost = ensureTitlebarMemoryHost();

      if (!nextHost) {
        return false;
      }

      if (!disposed) {
        setHost(nextHost);
      }

      return true;
    };

    if (!mountHost()) {
      observer = new MutationObserver(() => {
        if (mountHost()) {
          observer?.disconnect();
          observer = null;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const refreshJianyingStatus = async () => {
      try {
        const nextStatus = await getJianyingStatus();
        if (!disposed) {
          setJianyingStatus(nextStatus);
          setJianyingError(null);
        }
      } catch (error) {
        if (!disposed) setJianyingError(errorMessage(error));
      }
    };

    void refreshJianyingStatus();
    const interval = window.setInterval(() => void refreshJianyingStatus(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const refreshRuntimeStatus = async () => {
      try {
        const nextStatus = await getAppRuntimeStatus();

        if (!disposed) {
          setRuntimeStatus(nextStatus);
        }
      } catch {
        if (!disposed) {
          setRuntimeStatus(null);
        }
      }
    };

    void refreshRuntimeStatus();
    const interval = window.setInterval(() => {
      void refreshRuntimeStatus();
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const refreshBaiduStatus = async () => {
      try {
        const nextStatus = await getBaiduNetdiskStatus();

        if (!disposed) {
          setBaiduStatus(nextStatus);
          setBaiduError(null);
        }
      } catch (error) {
        if (!disposed) {
          setBaiduError(errorMessage(error));
        }
      }
    };

    void refreshBaiduStatus();
    const interval = window.setInterval(() => {
      void refreshBaiduStatus();
    }, 3000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  if (!host) {
    return null;
  }

  const memory = runtimeStatus?.memory ?? null;
  const percent = memory?.systemUsedPercent ?? null;
  const percentText = formatPercent(percent);
  const dDrive = runtimeStatus?.disk?.dDrive ?? null;
  const dDrivePercent = dDrive?.usedPercent ?? null;
  const dDrivePercentText = formatPercent(dDrivePercent);
  const browserInstanceCount = runtimeStatus?.browserInstanceCount ?? 0;
  const runningPlatformCount = runtimeStatus?.runningPlatformCount ?? 0;
  const totalPlatformCount = runtimeStatus?.totalPlatformCount ?? 5;
  const runningPlatformText = `${runningPlatformCount}/${totalPlatformCount}`;
  const memoryText = memory
    ? `${formatBytes(memory.systemUsedBytes)} / ${formatBytes(memory.systemTotalBytes)}（${percentText}）`
    : "读取中";
  const dDriveText = dDrive
    ? `可用 ${formatBytes(dDrive.availableBytes)} / 总量 ${formatBytes(dDrive.totalBytes)}（已用 ${formatPercent(dDrivePercent)}）`
    : runtimeStatus
      ? "未找到 D 盘"
      : "读取中";
  const baiduSummary = baiduNetdiskSummary(baiduStatus, baiduError);
  const jianyingStatusSummary = jianyingSummary(jianyingStatus, jianyingError);

  return createPortal(
    <div className="flex h-7 items-center gap-1.5 overflow-hidden whitespace-nowrap px-1 text-[11px] leading-none text-muted-foreground">
      <div className="flex h-6 items-center gap-1">
        <TitlebarMetric
          ariaLabel={`系统内存：${memoryText}`}
          icon={
            <Activity
              className={`size-3.5 shrink-0 ${memoryIconClass(percent)}`}
              aria-hidden="true"
            />
          }
          label="内存"
          value={percentText}
        />
        <TitlebarMetric
          ariaLabel={`D 盘容量：${dDriveText}`}
          icon={
            <HardDrive
              className={`size-3.5 shrink-0 ${diskIconClass(dDrivePercent)}`}
              aria-hidden="true"
            />
          }
          label="D盘"
          value={dDrivePercentText}
        />
        <TitlebarMetric
          ariaLabel={`运行平台：${runningPlatformText}`}
          icon={
            <Grid
              className={`size-3.5 shrink-0 ${runningPlatformIconClass(runningPlatformCount)}`}
              aria-hidden="true"
            />
          }
          label="平台"
          value={runningPlatformText}
        />
        <TitlebarMetric
          ariaLabel={`浏览器实例：${browserInstanceCount} 个`}
          icon={
            <Chrome
              className={`size-3.5 shrink-0 ${browserIconClass(browserInstanceCount)}`}
              aria-hidden="true"
            />
          }
          label="页面"
          value={browserInstanceCount}
        />
      </div>
      <div className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <Tooltip>
        <TooltipTrigger
          aria-label={`打开百度网盘 CDP 控制：${baiduSummary}`}
          render={
            <button
              type="button"
              className={titlebarIconButtonClass}
              onClick={openBaiduNetdiskDialog}
            />
          }
        >
          <CloudDownload
            className={`size-3.5 shrink-0 ${baiduNetdiskIconClass(baiduStatus, baiduError)}`}
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8} className="z-[100000]">
          百度网盘：{baiduSummary}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          aria-label={`打开剪映控制：${jianyingStatusSummary}`}
          render={
            <button
              type="button"
              className={titlebarIconButtonClass}
              onClick={openJianyingDialog}
            />
          }
        >
          <Scissors
            className={`size-3.5 shrink-0 ${jianyingIconClass(jianyingStatus, jianyingError)}`}
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8} className="z-[100000]">
          剪映：{jianyingStatusSummary}
        </TooltipContent>
      </Tooltip>
    </div>,
    host,
  );
}
