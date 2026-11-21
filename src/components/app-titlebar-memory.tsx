import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ActivityIcon as Activity, CloudDownloadIcon as CloudDownload, HardDriveIcon as HardDrive } from "@/components/ui/solar-icons";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { BaiduNetdiskPanel } from "@/pages/baidu-netdisk/window";
import {
  getBaiduNetdiskStatus,
  getBaiduNetdiskQuota,
  type BaiduNetdiskCdpStatus,
  type BaiduNetdiskQuota,
} from "@/platforms/baidu-netdisk/service";

type AppRuntimeStatus = {
  browserInstanceCount: number;
  runningPlatformCount: number;
  totalPlatformCount: number;
  disk?: {
    storageDrive: {
      directory: string;
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
  if (!Number.isFinite(bytes) || bytes < 0) {
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

function formatCheckedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function CapacityDetails({ label, used, total, available, percent }: {
  label: string;
  used: number;
  total: number;
  available: number;
  percent: number;
}) {
  const value = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const indicatorClass = value >= 90
    ? "[&_[data-slot=progress-indicator]]:bg-rose-500"
    : value >= 80
      ? "[&_[data-slot=progress-indicator]]:bg-amber-500"
      : "[&_[data-slot=progress-indicator]]:bg-primary";

  return (
    <div className="space-y-2.5 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">已使用</span>
        <span className="font-medium tabular-nums">{formatBytes(used)} / {formatBytes(total)}</span>
      </div>
      <Progress value={value} aria-label={`${label}已使用 ${formatPercent(value)}`} className={indicatorClass} />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>可用 {formatBytes(available)}</span>
        <span className="tabular-nums">{formatPercent(value)}</span>
      </div>
    </div>
  );
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

function baiduNetdiskIconClass(status: BaiduNetdiskCdpStatus | null, error: string | null) {
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
    return "已连接";
  }

  if (!status.appRunning) {
    return "百度网盘未启动";
  }

  if (!status.cdpRunning) {
    return "未以 CDP 模式启动";
  }

  return status.message;
}

async function getAppRuntimeStatus() {
  if (!window.ipcRenderer) {
    throw new Error("应用运行状态仅在 Electron 应用内可用");
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
  icon?: ReactNode;
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
  const [baiduQuota, setBaiduQuota] = useState<BaiduNetdiskQuota | null>(null);
  const baiduReady = baiduStatus?.ready === true && !baiduError;

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

  useEffect(() => {
    if (!baiduReady) {
      setBaiduQuota(null);
      return;
    }
    let disposed = false,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const quota = await getBaiduNetdiskQuota();
        if (!disposed) setBaiduQuota(quota);
      } catch {
        if (!disposed) setBaiduQuota(null);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [baiduReady]);

  if (!host) {
    return null;
  }

  const memory = runtimeStatus?.memory ?? null;
  const percent = memory?.systemUsedPercent ?? null;
  const percentText = formatPercent(percent);
  const storageDrive = runtimeStatus?.disk?.storageDrive ?? null;
  const storageDrivePercent = storageDrive?.usedPercent ?? null;
  const storageDrivePercentText = formatPercent(storageDrivePercent);
  const memoryText = memory
    ? `${formatBytes(memory.systemUsedBytes)} / ${formatBytes(memory.systemTotalBytes)}（${percentText}）`
    : "读取中";
  const storageDriveText = storageDrive
    ? `${storageDrive.directory}：可用 ${formatBytes(storageDrive.availableBytes)} / 总量 ${formatBytes(storageDrive.totalBytes)}（已用 ${formatPercent(storageDrivePercent)}）`
    : runtimeStatus
      ? "无法读取素材目录所在磁盘"
      : "读取中";
  const baiduSummary = baiduNetdiskSummary(baiduStatus, baiduError);
  const baiduConnectionHint = baiduError || (baiduStatus && !baiduStatus.ready)
    ? baiduStatus?.supported === false
      ? "当前系统暂不支持网盘自动下载"
      : "点击连接并登录网盘，即可自动下载素材"
    : null;
  const baiduPercent =
    baiduQuota && baiduQuota.total > 0 ? (baiduQuota.used / baiduQuota.total) * 100 : null;
  const baiduCapacity = baiduQuota
    ? `已用 ${formatBytes(baiduQuota.used)} / 总量 ${formatBytes(baiduQuota.total)}`
    : "容量暂不可用";
  const baiduCheckedAt = baiduQuota ? formatCheckedAt(baiduQuota.checkedAt) : null;

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
        <HoverCard>
          <HoverCardTrigger
            delay={150}
            closeDelay={150}
            aria-label={`素材盘容量：${storageDriveText}`}
            render={<button type="button" className={`${titlebarMetricClass} cursor-pointer`} />}
          >
            <HardDrive className={`size-3.5 shrink-0 ${diskIconClass(storageDrivePercent)}`} aria-hidden="true" />
            <span className="font-medium text-muted-foreground max-[840px]:hidden">素材盘</span>
            <span className="font-medium tabular-nums text-foreground">{storageDrivePercentText}</span>
          </HoverCardTrigger>
          <HoverCardContent side="bottom" align="end" sideOffset={8} className="w-72 max-w-[calc(100vw-1rem)] space-y-3 p-3.5">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70">
                <HardDrive className={`size-4 ${diskIconClass(storageDrivePercent)}`} aria-hidden="true" />
              </span>
              <div className="space-y-0.5">
                <div className="text-xs font-medium">素材盘</div>
                <div className="text-[11px] text-muted-foreground">素材目录所在磁盘</div>
              </div>
            </div>
            {storageDrive && storageDrivePercent !== null ? (
              <>
                <CapacityDetails label="素材盘" used={storageDrive.usedBytes} total={storageDrive.totalBytes} available={storageDrive.availableBytes} percent={storageDrivePercent} />
                <div className="space-y-1 text-xs">
                  <div className="text-muted-foreground">素材目录</div>
                  <div className="break-all leading-relaxed" title={storageDrive.directory}>{storageDrive.directory}</div>
                </div>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">{storageDriveText}</p>
            )}
          </HoverCardContent>
        </HoverCard>
        <Popover>
          <PopoverTrigger
            aria-label={`百度网盘：${baiduSummary}；${baiduCapacity}`}
            render={
              <button
                type="button"
                className={`${titlebarIconButtonClass} w-auto gap-1.5 px-2`}
              />
            }
          >
            <CloudDownload
              className={`size-3.5 shrink-0 ${baiduNetdiskIconClass(baiduStatus, baiduError)}`}
              aria-hidden="true"
            />
            <span>网盘</span>
            {baiduConnectionHint ? (
              <span className="text-[11px] font-normal text-amber-700 dark:text-amber-400">
                {baiduConnectionHint}
              </span>
            ) : (
              <span className="font-medium tabular-nums text-foreground">
                {baiduPercent === null ? "--" : `${baiduPercent.toFixed(1)}%`}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" sideOffset={8} className="w-80 max-w-[calc(100vw-1rem)] gap-3 p-3.5">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70">
                <CloudDownload className={`size-4 ${baiduNetdiskIconClass(baiduStatus, baiduError)}`} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <PopoverTitle className="text-xs">百度网盘</PopoverTitle>
                <div className="text-[11px] text-muted-foreground">素材下载与云端容量</div>
              </div>
              <span className={`rounded-full px-2 py-1 text-[11px] ${baiduReady ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                {baiduReady ? "已连接" : baiduError || baiduStatus ? "未连接" : "读取中"}
              </span>
            </div>
            {baiduReady && baiduQuota && baiduPercent !== null ? (
              <>
                <CapacityDetails label="百度网盘" used={baiduQuota.used} total={baiduQuota.total} available={Math.max(0, baiduQuota.total - baiduQuota.used)} percent={baiduPercent} />
                {baiduCheckedAt && <p className="text-[11px] text-muted-foreground">容量更新于 {baiduCheckedAt}</p>}
              </>
            ) : (
              <p className="break-words text-xs leading-relaxed text-muted-foreground">
                {baiduReady ? baiduCapacity : baiduStatus?.supported === false ? "当前系统暂不支持网盘自动下载" : baiduSummary}
              </p>
            )}
            <BaiduNetdiskPanel />
          </PopoverContent>
        </Popover>
      </div>
    </div>,
    host,
  );
}
