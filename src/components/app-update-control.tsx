import {
  CheckCircle,
  DangerTriangle,
  Download,
  Power,
  Refresh,
  SpinnerOne,
  StopCircle,
} from "@mynaui/icons-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverHeader, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  cancelAppUpdateDownload,
  checkForAppUpdate,
  downloadAppUpdate,
  getAppUpdateStatus,
  installAppUpdate,
  onAppUpdateChanged,
  setAppUpdateSource,
  type AppUpdateSourceSelection,
  type AppUpdateStatus,
} from "@/platforms/app-runtime/service";

type UpdateAction = "check" | "download" | "install" | "source" | "cancel";

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function updateSummary(status: AppUpdateStatus | null) {
  if (!status) return "读取中";
  if (!status.enabled) return "更新不可用";

  switch (status.state) {
    case "checking":
      return "正在检查更新";
    case "available":
      return status.latestVersion ? `发现 v${status.latestVersion}` : "发现新版本";
    case "not-available":
      return "当前已是最新版本";
    case "downloading":
      return `正在下载 ${formatPercent(status.progress?.percent ?? null)}`;
    case "downloaded":
      return "更新已下载，等待重启安装";
    case "installing":
      return "正在重启安装";
    case "error":
      return status.error ?? "更新异常";
    case "idle":
    default:
      return "未检查更新";
  }
}

function updateDescription(status: AppUpdateStatus | null) {
  if (!status) return "正在读取更新状态。";
  if (!status.enabled) return "当前环境暂不支持应用内更新。";

  if (status.state === "available") {
    return "自动下载已暂停或尚未开始，可以手动继续下载。";
  }

  if (status.state === "downloaded") {
    return status.runningPlatformCount > 0
      ? `${status.runningPlatformCount} 个平台服务正在运行，可一键停止后重启安装。`
      : "更新已就绪，安装时应用会自动关闭并重启。";
  }

  if (status.state === "not-available") {
    return "没有比当前安装包更新的正式版本。";
  }

  return "检查 Windows 安装包更新。";
}

function updateIconClass(status: AppUpdateStatus | null, actionPending: UpdateAction | null) {
  if (actionPending || status?.state === "checking" || status?.state === "downloading") {
    return "text-sky-500";
  }

  if (!status || !status.enabled || status.state === "not-available") {
    return "text-muted-foreground/70";
  }

  if (status.state === "available") {
    return "text-violet-500";
  }

  if (status.state === "downloaded") {
    return "text-emerald-500";
  }

  if (status.state === "error") {
    return "text-rose-500";
  }

  return "text-muted-foreground/70";
}

function updateButtonLabel(status: AppUpdateStatus | null, actionPending: UpdateAction | null) {
  if (actionPending === "cancel") return "取消中";
  if (actionPending === "check" || status?.state === "checking") return "检查中";
  if (actionPending === "download" || status?.state === "downloading") {
    return formatPercent(status?.progress?.percent ?? null);
  }
  if (actionPending === "install" || status?.state === "installing") return "重启中";
  if (status?.state === "downloaded") return "安装";
  if (status?.state === "available") return "更新";
  if (status?.state === "error") return "异常";

  return "更新";
}

function UpdateStateIcon({
  status,
  actionPending,
}: {
  status: AppUpdateStatus | null;
  actionPending: UpdateAction | null;
}) {
  const iconClass = `size-3.5 shrink-0 ${updateIconClass(status, actionPending)}`;

  if (actionPending || status?.state === "checking" || status?.state === "downloading") {
    return <SpinnerOne className={`${iconClass} animate-spin`} aria-hidden="true" />;
  }

  if (status?.state === "downloaded") {
    return <CheckCircle className={iconClass} aria-hidden="true" />;
  }

  if (status?.state === "error") {
    return <DangerTriangle className={iconClass} aria-hidden="true" />;
  }

  return <Refresh className={iconClass} aria-hidden="true" />;
}

export function AppUpdateControl({
  iconOnly = false,
  page = false,
}: {
  iconOnly?: boolean;
  page?: boolean;
}) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [actionPending, setActionPending] = useState<UpdateAction | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false);
  const notifiedDownloadedVersion = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const refreshUpdateStatus = async () => {
      try {
        const nextStatus = await getAppUpdateStatus();

        if (!disposed) {
          setStatus(nextStatus);
        }
      } catch {
        if (!disposed) {
          setStatus(null);
        }
      }
    };

    void refreshUpdateStatus();
    const dispose = onAppUpdateChanged((nextStatus) => {
      if (!disposed) {
        setStatus(nextStatus);
        if (
          nextStatus.state === "downloaded" &&
          nextStatus.latestVersion &&
          notifiedDownloadedVersion.current !== nextStatus.latestVersion
        ) {
          notifiedDownloadedVersion.current = nextStatus.latestVersion;
          toast.success(`v${nextStatus.latestVersion} 已在后台下载完成`, {
            description: "请在平台任务结束后重启安装。",
          });
        }
      }
    });

    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  const runUpdateAction = (action: UpdateAction, task: () => Promise<AppUpdateStatus>) => {
    void (async () => {
      setActionPending(action);

      try {
        const nextStatus = await task();
        setStatus(nextStatus);

        if (action === "check" && nextStatus.state === "available") {
          toast.info(`发现新版本 v${nextStatus.latestVersion ?? ""}`);
        } else if (action === "check" && nextStatus.state === "not-available") {
          toast.success("当前已是最新版本。");
        } else if (action === "check" && nextStatus.state === "error") {
          toast.error(nextStatus.error ?? "检查更新失败。");
        } else if (action === "cancel") {
          toast.info("下载已取消，可以切换更新源后重新检查。");
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setActionPending(null);
      }
    })();
  };

  const summary = updateSummary(status);
  const description = updateDescription(status);
  const busy =
    actionPending !== null || status?.state === "checking" || status?.state === "downloading";
  const enabled = Boolean(status?.enabled);
  const canDownload =
    enabled &&
    !busy &&
    (status?.state === "available" || (status?.state === "error" && Boolean(status.latestVersion)));
  const canInstall = enabled && !busy && status?.state === "downloaded";
  const progress = status?.progress;
  const versionText = status?.latestVersion
    ? `v${status.currentVersion} 到 v${status.latestVersion}`
    : `v${status?.currentVersion ?? "--"}`;
  const downloadText = progress
    ? `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)} · ${formatBytes(progress.bytesPerSecond)}/s`
    : null;
  const sourceLocked = busy || status?.state === "installing" || status?.state === "downloaded";

  const changeUpdateSource = (selection: AppUpdateSourceSelection) => {
    if (
      !status ||
      (selection === "auto" && status.sourceMode === "auto") ||
      (selection !== "auto" && status.sourceMode === "manual" && selection === status.source.id)
    ) {
      return;
    }

    runUpdateAction("source", () => setAppUpdateSource(selection));
  };

  const changePopoverOpen = (open: boolean) => {
    setPopoverOpen(open);
    if (open) {
      void getAppUpdateStatus()
        .then(setStatus)
        .catch(() => undefined);
    }
  };

  const requestUpdateInstallation = () => {
    void (async () => {
      setActionPending("install");

      try {
        const nextStatus = await getAppUpdateStatus();
        setStatus(nextStatus);
        if (nextStatus.runningPlatformCount > 0) {
          setPopoverOpen(false);
          setInstallConfirmOpen(true);
          return;
        }

        setStatus(await installAppUpdate());
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setActionPending(null);
      }
    })();
  };

  const details = (
    <>
      <PopoverHeader className="gap-0">
        <div className="flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
            <UpdateStateIcon status={status} actionPending={actionPending} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-6">版本与更新</h2>
            <p className="text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
      </PopoverHeader>

      <div
        className={cn(
          "grid text-xs",
          page ? "gap-2 border-y border-border/60 py-3" : "gap-1 rounded-md bg-muted/40 p-2",
        )}
      >
        <div className="flex items-center justify-between gap-3 leading-5">
          <span className="text-muted-foreground">状态</span>
          <span className="min-w-0 truncate font-medium">{summary}</span>
        </div>
        <div className="flex items-center justify-between gap-3 leading-5">
          <span className="text-muted-foreground">版本</span>
          <span className="font-medium tabular-nums">{versionText}</span>
        </div>
        <div className="flex items-center justify-between gap-3 leading-5">
          <span className="text-muted-foreground">更新方式</span>
          <span className="min-w-0 truncate font-medium">
            {status?.sourceMode === "auto" ? `自动 · ${status.source.label}` : "手动固定"}
          </span>
        </div>
        {status?.lastCheckedAt ? (
          <div className="flex items-center justify-between gap-3 leading-5">
            <span className="text-muted-foreground">上次检查</span>
            <span className="font-medium tabular-nums">
              {new Date(status.lastCheckedAt).toLocaleTimeString()}
            </span>
          </div>
        ) : null}
        {status?.nextCheckAt ? (
          <div className="flex items-center justify-between gap-3 leading-5">
            <span className="text-muted-foreground">下次检查</span>
            <span className="font-medium tabular-nums">
              {new Date(status.nextCheckAt).toLocaleTimeString()}
            </span>
          </div>
        ) : null}
        {status?.releaseDate ? (
          <div className="flex items-center justify-between gap-3 leading-5">
            <span className="text-muted-foreground">发布时间</span>
            <span className="font-medium tabular-nums">
              {new Date(status.releaseDate).toLocaleString()}
            </span>
          </div>
        ) : null}
      </div>

      {status ? (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="app-update-source" className="text-xs text-muted-foreground">
              更新源
            </label>
            <Select
              value={status.sourceMode === "auto" ? "auto" : status.source.id}
              disabled={sourceLocked}
              onValueChange={(value) => {
                if (value) changeUpdateSource(value as AppUpdateSourceSelection);
              }}
            >
              <SelectTrigger id="app-update-source" size="sm" className="w-48 bg-background">
                <SelectValue>
                  {status.sourceMode === "auto" ? "自动选择（推荐）" : status.source.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end" positionerClassName="z-[100001]" className="max-w-64">
                <SelectItem value="auto">自动选择（推荐）</SelectItem>
                {status.sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {status.retryAttempt ? (
            <p className="text-xs leading-4 text-amber-600 dark:text-amber-400">
              正在尝试第 {status.retryAttempt + 1} 个更新源
            </p>
          ) : null}
        </div>
      ) : null}

      {progress ? (
        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-3 text-xs leading-5">
            <span className="text-muted-foreground">下载进度</span>
            <span className="font-medium tabular-nums">{formatPercent(progress.percent)}</span>
          </div>
          <Progress value={progress.percent} />
          {downloadText ? (
            <span className="text-xs leading-4 text-muted-foreground">{downloadText}</span>
          ) : null}
        </div>
      ) : null}

      {status?.error ? (
        <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-5 text-destructive">
          {status.error}
        </div>
      ) : null}

      {status?.releaseNotes ? (
        <div
          className={cn(
            "overflow-auto text-xs leading-5 whitespace-pre-wrap text-muted-foreground",
            page ? "max-h-64" : "max-h-24 rounded-md bg-muted/40 px-2 py-1.5",
          )}
        >
          {status.releaseNotes}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!enabled || busy}
          onClick={() => runUpdateAction("check", checkForAppUpdate)}
        >
          <Refresh className={actionPending === "check" ? "animate-spin" : ""} aria-hidden="true" />
          <span>{actionPending === "check" ? "检查中" : "检查"}</span>
        </Button>
        {status?.state === "downloading" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={actionPending === "cancel"}
            onClick={() => runUpdateAction("cancel", cancelAppUpdateDownload)}
          >
            <StopCircle aria-hidden="true" />
            <span>{actionPending === "cancel" ? "取消中" : "取消"}</span>
          </Button>
        ) : null}
        {canDownload ? (
          <Button
            type="button"
            size="xs"
            disabled={actionPending !== null}
            onClick={() => runUpdateAction("download", downloadAppUpdate)}
          >
            <Download aria-hidden="true" />
            <span>{actionPending === "download" ? "下载中" : "下载"}</span>
          </Button>
        ) : null}
        {canInstall ? (
          <Button
            type="button"
            size="xs"
            disabled={actionPending !== null}
            onClick={requestUpdateInstallation}
          >
            <Power aria-hidden="true" />
            <span>{actionPending === "install" ? "重启中" : "重启安装"}</span>
          </Button>
        ) : null}
      </div>
    </>
  );

  return (
    <Popover open={popoverOpen} onOpenChange={changePopoverOpen}>
      {!page && (
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      buttonVariants({ size: iconOnly ? "icon-sm" : "xs", variant: "ghost" }),
                      iconOnly && "text-muted-foreground transition-none",
                    )}
                    aria-label={`应用更新：${summary}`}
                  />
                }
              />
            }
          >
            <span className="inline-flex h-full items-center gap-1 leading-none">
              <UpdateStateIcon status={status} actionPending={actionPending} />
              {!iconOnly && <span>{updateButtonLabel(status, actionPending)}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" sideOffset={8}>
            应用更新：{summary}
          </TooltipContent>
        </Tooltip>
      )}

      {page ? (
        <section
          aria-label="版本与更新"
          className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-5"
        >
          {details}
        </section>
      ) : (
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className="z-[100000] w-72 max-w-[calc(100vw-1rem)] gap-2 p-2"
        >
          {details}
        </PopoverContent>
      )}
      <AlertDialog open={installConfirmOpen} onOpenChange={setInstallConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <DangerTriangle aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>停止全部服务并安装更新？</AlertDialogTitle>
            <AlertDialogDescription>
              将停止当前运行的 {status?.runningPlatformCount ?? 0} 个平台服务。
              正在处理的上传或发布任务会中断；随后应用将立即重启并安装
              {status?.latestVersion ? ` v${status.latestVersion}` : "新版本"}。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionPending === "install"}>暂不安装</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={actionPending === "install"}
              onClick={() => {
                setInstallConfirmOpen(false);
                runUpdateAction("install", () => installAppUpdate({ stopRunningServices: true }));
              }}
            >
              <Power aria-hidden="true" />
              停止全部并重启安装
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Popover>
  );
}
