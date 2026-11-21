import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { ManagementStatusSkeleton, ManagementTableSkeleton } from "@/pages/shared/management-skeleton";
import { FilterSearchField, FilterToolbar } from "@/components/filter-controls";
import { FailureTooltip } from "@/components/ui/failure-tooltip";
import { OverflowText } from "@/components/ui/overflow-text";
import { ChevronLeftIcon as ChevronLeft, ChevronRightIcon as ChevronRight, ChevronsLeftIcon as ChevronsLeft, ChevronsRightIcon as ChevronsRight } from "@/components/ui/solar-icons";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircleIcon as CheckCircle, DangerTriangleIcon as DangerTriangle } from "@/components/ui/solar-icons";
import { toast } from "@/components/ui/notifications";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListFilterMenu } from "@/components/list-filter-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  wechatMiniProgramCatalogUploadService,
  type WechatMiniProgramCatalogUploadTask,
  type WechatMiniProgramCatalogUploadState,
  type WechatMiniProgramCatalogUploadWorkspace,
} from "@/platforms/wechat-miniprogram-drama/catalog-upload-service";
import { wechatMiniProgramService } from "@/platforms/wechat-miniprogram-drama/service";

const stateLabels: Record<WechatMiniProgramCatalogUploadState, string> = {
  discovered: "等待处理",
  "missing-source": "缺少网盘链接",
  downloading: "下载素材",
  uploading: "上传素材",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function stateVariant(state: WechatMiniProgramCatalogUploadState) {
  if (state === "completed") return "secondary" as const;
  if (["failed", "interrupted"].includes(state)) return "destructive" as const;
  if (["downloading", "uploading"].includes(state)) return "default" as const;
  return "outline" as const;
}

function stateClassName(state: WechatMiniProgramCatalogUploadState) {
  if (state === "completed") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (["downloading", "uploading"].includes(state)) {
    return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (state === "missing-source") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return undefined;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

const lifecycleLabels: Record<string, string> = {
  DRAFT: "草稿",
  MATERIAL_PENDING: "素材待完善",
  READY_TO_SUBMIT: "待提交",
  SUBMITTING: "提交中",
  UNDER_REVIEW: "审核中",
  APPROVED: "审核通过",
  PENDING_PUBLISH: "待发布",
  REJECTED: "审核驳回",
  PUBLISHED: "已发布",
  REMOTE_SYNCED: "已同步",
};

const publishStatusLabels: Record<string, string> = {
  ONLINE: "已上线",
  OFFLINE: "未上线",
};

type StateFilter = "all" | WechatMiniProgramCatalogUploadState;
type MaterialFilter = "all" | "complete" | "pending" | "failed";
type SourceFilter = "all" | "available" | "missing";
type SelectOption<T extends string | number> = { value: T; label: string };

const pageSizeOptions = [20, 50, 100] as const;

function parseAutoSyncSeconds(value: string) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 15;
}

const stateFilterOptions: SelectOption<StateFilter>[] = [
  { value: "all", label: "全部任务状态" },
  ...Object.entries(stateLabels).map(([value, label]) => ({
    value: value as WechatMiniProgramCatalogUploadState,
    label,
  })),
];

const episodeFilterOptions: SelectOption<MaterialFilter>[] = [
  { value: "all", label: "全部前四集" },
  { value: "complete", label: "前四集已入库" },
  { value: "pending", label: "前四集待入库" },
  { value: "failed", label: "前四集失败" },
];

const coverFilterOptions: SelectOption<MaterialFilter>[] = [
  { value: "all", label: "全部封面" },
  { value: "complete", label: "封面已入库" },
  { value: "pending", label: "封面待入库" },
  { value: "failed", label: "封面失败" },
];

const sourceFilterOptions: SelectOption<SourceFilter>[] = [
  { value: "all", label: "全部网盘资源" },
  { value: "available", label: "已有网盘链接" },
  { value: "missing", label: "缺少网盘链接" },
];

function episodesComplete(task: WechatMiniProgramCatalogUploadTask) {
  return (
    task.hasFirstFourEpisodes ||
    (task.targetEpisodeCount > 0 && task.uploadedEpisodeCount >= task.targetEpisodeCount)
  );
}

function coverComplete(task: WechatMiniProgramCatalogUploadTask) {
  return task.hasCover || ["uploaded", "existing"].includes(task.coverStatus);
}

function episodesFailed(task: WechatMiniProgramCatalogUploadTask) {
  return task.episodeStatuses.some((episode) => episode.state === "failed");
}

function taskStateLabel(task: WechatMiniProgramCatalogUploadTask) {
  if (task.state === "downloading" || task.state === "uploading") {
    const action = task.state === "downloading" ? "下载" : "上传";
    if (episodesComplete(task) && !coverComplete(task)) return `${action}封面`;
    if (!episodesComplete(task) && coverComplete(task)) return `${action}前四集`;
    return `${action}前四集与封面`;
  }
  return stateLabels[task.state];
}

function lifecycleLabel(value?: string) {
  if (!value) return "未知";
  return lifecycleLabels[value.toUpperCase()] ?? value;
}

function CompactSelect<T extends string | number>({
  ariaLabel,
  className,
  options,
  value,
  onValueChange,
}: {
  ariaLabel: string;
  className: string;
  options: SelectOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onValueChange(nextValue);
      }}
    >
      <SelectTrigger size="sm" className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={String(option.value)} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function WechatMiniProgramCatalogUploadWindow() {
  const [workspace, setWorkspace] = useState<WechatMiniProgramCatalogUploadWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [autoSyncSeconds, setAutoSyncSeconds] = useState(15);
  const [keyword, setKeyword] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [episodeFilter, setEpisodeFilter] = useState<MaterialFilter>("all");
  const [coverFilter, setCoverFilter] = useState<MaterialFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);
  const autoSyncInFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setWorkspace(await wechatMiniProgramCatalogUploadService.workspace());
    } catch (error) {
      toast.error("无法读取前四集与封面入库记录", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = wechatMiniProgramCatalogUploadService.onWorkspaceChanged(setWorkspace);
    return () => {
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void wechatMiniProgramService
      .getConfig()
      .then(({ config }) => {
        if (active) setAutoSyncSeconds(parseAutoSyncSeconds(config.catalogAutoSyncIntervalSeconds));
      })
      .catch(() => {
        // Keep the default interval when configuration is unavailable, such as in browser previews.
      });
    const unsubscribe = wechatMiniProgramService.onConfigChanged(({ config }) => {
      setAutoSyncSeconds(parseAutoSyncSeconds(config.catalogAutoSyncIntervalSeconds));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (autoSyncSeconds === 0 || workspace?.queue.running || workspace?.sync.running) return;

    const syncCatalog = async () => {
      if (autoSyncInFlight.current) return;
      autoSyncInFlight.current = true;
      try {
        setWorkspace(await wechatMiniProgramCatalogUploadService.syncCatalog());
      } catch {
        // The main process broadcasts sync errors as workspace state. Keep automatic
        // retries quiet so a temporary API failure does not produce repeated toasts.
      } finally {
        autoSyncInFlight.current = false;
      }
    };

    const interval = window.setInterval(() => void syncCatalog(), autoSyncSeconds * 1000);
    return () => window.clearInterval(interval);
  }, [autoSyncSeconds, workspace?.queue.running, workspace?.sync.running]);

  const counts = useMemo(() => {
    const tasks = workspace?.tasks ?? [];
    return {
      episodesComplete: tasks.filter(episodesComplete).length,
      coversComplete: tasks.filter(coverComplete).length,
      failed: tasks.filter((task) => ["failed", "interrupted"].includes(task.state)).length,
      missing: tasks.filter((task) => !task.baiduNetdiskUrl?.trim()).length,
    };
  }, [workspace]);

  const retryableTasks = useMemo(
    () =>
      (workspace?.tasks ?? []).filter(
        (task) =>
          ["failed", "interrupted"].includes(task.state) && Boolean(task.baiduNetdiskUrl?.trim()),
      ),
    [workspace],
  );

  const filteredTasks = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLocaleLowerCase("zh-CN");
    return (workspace?.tasks ?? []).filter((task) => {
      if (stateFilter !== "all" && task.state !== stateFilter) return false;
      const episodeComplete = episodesComplete(task);
      const episodeFailed = episodesFailed(task);
      const isCoverComplete = coverComplete(task);
      if (episodeFilter === "complete" && !episodeComplete) return false;
      if (episodeFilter === "pending" && (episodeComplete || episodeFailed)) return false;
      if (episodeFilter === "failed" && !episodeFailed) return false;
      if (coverFilter === "complete" && !isCoverComplete) return false;
      if (coverFilter === "pending" && (isCoverComplete || task.coverStatus === "failed"))
        return false;
      if (coverFilter === "failed" && task.coverStatus !== "failed") return false;
      if (sourceFilter === "available" && !task.baiduNetdiskUrl) return false;
      if (sourceFilter === "missing" && task.baiduNetdiskUrl) return false;
      if (!normalizedKeyword) return true;
      return [
        task.dramaName,
        task.dramaId,
        task.wxDramaId,
        task.baiduNetdiskUrl,
        task.error,
        task.lifecycleStatus,
      ].some((value) =>
        String(value ?? "")
          .toLocaleLowerCase("zh-CN")
          .includes(normalizedKeyword),
      );
    });
  }, [coverFilter, episodeFilter, keyword, sourceFilter, stateFilter, workspace]);

  const totalPages = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
  const pagedTasks = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredTasks.slice(start, start + pageSize);
  }, [currentPage, filteredTasks, pageSize]);
  useEffect(() => {
    setCurrentPage(1);
  }, [coverFilter, episodeFilter, keyword, pageSize, sourceFilter, stateFilter]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const resetFilters = () => {
    setKeyword("");
    setStateFilter("all");
    setEpisodeFilter("all");
    setCoverFilter("all");
    setSourceFilter("all");
  };

  const runAction = async (
    key: string,
    action: () => Promise<WechatMiniProgramCatalogUploadWorkspace>,
    success?: string,
  ) => {
    if (pendingAction) return;
    setPendingAction(key);
    try {
      setWorkspace(await action());
      if (success) toast.success(success);
    } catch (error) {
      toast.error("操作失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  };

  const initialLoading = loading && !workspace;

  return (
    <main className="flex h-full min-h-0 flex-col bg-background font-workspace text-sm text-foreground [&_[data-slot=button]]:text-xs">
          <WorkspaceActions label="素材入库操作">
            <Button
              size="sm" className="h-7 px-3 text-xs" aria-label="获取全部剧目" title="获取全部剧目"
              variant="outline"
              disabled={initialLoading || pendingAction !== null || Boolean(workspace?.queue.running)}
              onClick={() =>
                void runAction(
                  "sync",
                  wechatMiniProgramCatalogUploadService.syncCatalog,
                  "全部剧目和后台状态已更新",
                )
              }
            >
              {pendingAction === "sync" || workspace?.sync.running ? "获取中…" : "获取剧目"}
            </Button>
            <Button
              size="sm" className="h-7 px-3 text-xs" aria-label="重试全部失败任务" title="重试全部失败任务"
              variant="outline"
              disabled={
                pendingAction !== null ||
                retryableTasks.length === 0 ||
                Boolean(workspace?.queue.running) ||
                Boolean(workspace?.sync.running)
              }
              onClick={() =>
                void runAction(
                  "retry-all",
                  () =>
                    wechatMiniProgramCatalogUploadService.retryTasks(
                      retryableTasks.map((task) => task.id),
                    ),
                  `已重新加入 ${retryableTasks.length} 个失败任务`,
                )
              }
            >
              {pendingAction === "retry-all" ? "重试中…" : "重试全部"}
            </Button>
            <Button
              size="sm" className="h-7 px-3 text-xs" aria-label={workspace?.queue.running ? "暂停接续" : "开始处理"} title={workspace?.queue.running ? "暂停接续" : "开始处理"}
              variant={workspace?.queue.running ? "outline" : "default"}
              disabled={initialLoading || pendingAction !== null || Boolean(workspace?.sync.running)}
              onClick={() =>
                void runAction(
                  "queue",
                  workspace?.queue.running
                    ? wechatMiniProgramCatalogUploadService.pauseQueue
                    : wechatMiniProgramCatalogUploadService.startQueue,
                  workspace?.queue.running ? "当前剧目处理完后暂停" : "已开始处理已同步剧目",
                )
              }
            >
              {workspace?.queue.running ? "暂停接续" : "开始处理"}
            </Button>
            {workspace?.queue.activeTaskId ? (
              <Button
                size="sm" className="h-7 px-3 text-xs" aria-label="终止当前剧目" title="终止当前剧目"
                variant="destructive"
                disabled={pendingAction !== null}
                onClick={() =>
                  void runAction("cancel", wechatMiniProgramCatalogUploadService.cancelActiveTask)
                }
              >
                终止当前剧目
              </Button>
            ) : null}
      </WorkspaceActions>
      <header className="shrink-0 border-b p-3" data-skeleton-transition>
        {initialLoading ? (
          <ManagementStatusSkeleton label="正在读取入库记录" />
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${workspace?.queue.running ? "bg-sky-500" : "bg-muted-foreground/40"}`}
              />
              {workspace?.queue.running ? "队列运行中" : "队列已暂停"}
            </span>
            <span className="text-muted-foreground">
              {workspace?.sync.running
                ? `同步第 ${Math.min((workspace.sync.currentPage ?? 0) + 1, workspace.sync.totalPages ?? 1)}/${workspace.sync.totalPages ?? "—"} 页，已读取 ${workspace.sync.syncedCount} 部`
                : `剧目 ${workspace?.tasks.length ?? 0} 部${workspace?.sync.lastSyncedAt ? `，更新于 ${formatDateTime(workspace.sync.lastSyncedAt)}` : ""}`}
            </span>
            {workspace?.queue.totalCount ? (
              <span className="text-muted-foreground">
                处理进度 {workspace.queue.processedCount}/{workspace.queue.totalCount}
              </span>
            ) : null}
            <span>前四集已入库 {counts.episodesComplete}</span>
            <span>封面已入库 {counts.coversComplete}</span>
            <span className="text-muted-foreground">缺链接 {counts.missing}</span>
            <span className={counts.failed ? "text-destructive" : "text-muted-foreground"}>
              失败 {counts.failed}
            </span>
            {workspace?.queue.error ? (
              <OverflowText as="span" className="max-w-96 truncate text-destructive" title={workspace.queue.error}>
                {workspace.queue.error}
              </OverflowText>
            ) : null}
            {workspace?.sync.error ? (
              <OverflowText as="span" className="max-w-96 truncate text-destructive" title={workspace.sync.error}>
                {workspace.sync.error}
              </OverflowText>
            ) : null}
          </div>
        )}
      </header>

      <section className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <FilterToolbar label="剧目筛选" className="shrink-0">
          <FilterSearchField
            label="搜索剧目"
            placeholder="搜索剧名、剧 ID 或网盘链接"
            value={keyword}
            onChange={setKeyword}
          />
          <ListFilterMenu
            label="筛选剧目"
            groups={[
              {
                key: "state",
                label: "任务状态",
                value: stateFilter,
                defaultValue: "all",
                options: stateFilterOptions,
                onChange: (value) => setStateFilter(value as StateFilter),
              },
              {
                key: "episodes",
                label: "前四集",
                value: episodeFilter,
                defaultValue: "all",
                options: episodeFilterOptions,
                onChange: (value) => setEpisodeFilter(value as MaterialFilter),
              },
              {
                key: "cover",
                label: "封面",
                value: coverFilter,
                defaultValue: "all",
                options: coverFilterOptions,
                onChange: (value) => setCoverFilter(value as MaterialFilter),
              },
              {
                key: "source",
                label: "网盘资源",
                value: sourceFilter,
                defaultValue: "all",
                options: sourceFilterOptions,
                onChange: (value) => setSourceFilter(value as SourceFilter),
              },
            ]}
          />
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            显示 {filteredTasks.length} / {workspace?.tasks.length ?? 0} 部
          </span>
        </FilterToolbar>
        {initialLoading || workspace?.tasks.length ? (
          initialLoading || filteredTasks.length ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <Table stickyActions aria-busy={initialLoading}
                containerClassName="h-full overflow-auto overscroll-contain"
                className="min-w-[1280px] table-fixed"
              >
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="h-8 w-16">剧 ID</TableHead>
                    <TableHead className="h-8 w-24">微信 ID</TableHead>
                    <TableHead className="h-8">剧目</TableHead>
                    <TableHead className="h-8 w-16 text-right">总集数</TableHead>
                    <TableHead className="h-8 w-20">网盘资源</TableHead>
                    <TableHead className="h-8 w-32">前四集</TableHead>
                    <TableHead className="h-8 w-32">封面</TableHead>
                    <TableHead className="h-8 w-22">生命周期</TableHead>
                    <TableHead className="h-8 w-20">发布状态</TableHead>
                    <TableHead className="h-8 w-24">处理状态</TableHead>
                    <TableHead className="h-8">异常信息</TableHead>
                    <TableHead className="h-8 w-28">最近更新</TableHead>
                    <TableHead className="h-8 w-20 text-left">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody data-skeleton-transition>
                  {initialLoading && (
                    <ManagementTableSkeleton
                      columns={["w-9", "w-14", "w-3/4 max-w-36", "ml-auto w-6", "w-12", "w-20", "w-20", "w-12", "w-12", "h-4 w-14 rounded-full", "w-3/4", "w-16", "h-5 w-12"]}
                      rowClassName="h-9"
                    />
                  )}
                  {pagedTasks.map((task) => {
                    const active = workspace?.queue.activeTaskId === task.id;
                    const episodeComplete = episodesComplete(task);
                    const episodeFailed = episodesFailed(task);
                    const isCoverComplete = coverComplete(task);
                    const episodeError = task.episodeStatuses.find(
                      (episode) => episode.state === "failed",
                    )?.error;
                    const error = task.error ?? task.coverError ?? episodeError;
                    return (
                      <TableRow key={task.id} data-active={active || undefined}>
                        <TableCell className="py-1.5 text-xs tabular-nums text-muted-foreground">
                          {task.dramaId}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs tabular-nums text-muted-foreground">
                          {task.wxDramaId ?? "—"}
                        </TableCell>
                        <TableCell className="min-w-0 py-1.5">
                          <OverflowText as="div" className="truncate font-medium" title={task.dramaName}>
                            {task.dramaName}
                          </OverflowText>
                        </TableCell>
                        <TableCell className="py-1.5 text-right text-xs tabular-nums">
                          {task.episodeCount}
                        </TableCell>
                        <TableCell className="py-1.5">
                          <div
                            className={`flex items-center gap-1.5 text-xs ${task.baiduNetdiskUrl ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}`}
                            title={task.baiduNetdiskUrl}
                          >
                            <span
                              aria-hidden="true"
                              className={`size-1.5 shrink-0 rounded-full ${task.baiduNetdiskUrl ? "bg-emerald-500" : "bg-amber-500"}`}
                            />
                            {task.baiduNetdiskUrl ? "已关联" : "缺少链接"}
                          </div>
                        </TableCell>
                        <TableCell className="py-1.5">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span
                              className={
                                episodeComplete
                                  ? "text-emerald-700 dark:text-emerald-300"
                                  : episodeFailed
                                    ? "text-destructive"
                                    : "text-foreground"
                              }
                            >
                              {episodeComplete ? "已入库" : episodeFailed ? "上传失败" : "待入库"}
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                              {Math.min(task.uploadedEpisodeCount, task.targetEpisodeCount)}/
                              {task.targetEpisodeCount} 集
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-1.5">
                          <div className="flex min-w-0 items-center gap-1.5 text-xs">
                            <span
                              className={
                                isCoverComplete
                                  ? "text-emerald-700 dark:text-emerald-300"
                                  : task.coverStatus === "failed"
                                    ? "text-destructive"
                                    : "text-foreground"
                              }
                            >
                              {isCoverComplete
                                ? "已入库"
                                : task.coverStatus === "failed"
                                  ? "上传失败"
                                  : "待入库"}
                            </span>
                            <OverflowText as="span"
                              className="truncate text-muted-foreground"
                              title={task.coverFileName}
                            >
                              {task.coverStatus === "existing" || task.hasCover
                                ? "后台已有"
                                : task.coverStatus === "uploaded"
                                  ? (task.coverFileName ?? "本次上传")
                                  : "—"}
                            </OverflowText>
                          </div>
                        </TableCell>
                        <TableCell className="truncate py-1.5 text-xs" title={task.lifecycleStatus}>
                          {lifecycleLabel(task.lifecycleStatus)}
                        </TableCell>
                        <TableCell
                          className="truncate py-1.5 text-xs"
                          title={task.actualPublishStatus}
                        >
                          {publishStatusLabels[task.actualPublishStatus ?? ""] ??
                            task.actualPublishStatus ??
                            "—"}
                        </TableCell>
                        <TableCell className="py-1.5">
                          <FailureTooltip reason={error}><Badge
                            variant={stateVariant(task.state)}
                            className={stateClassName(task.state)}
                            title={task.retryCount > 0 ? `已重试 ${task.retryCount} 次` : undefined}
                          >
                            {active ? (
                              <Spinner className="size-3" />
                            ) : task.state === "completed" ? (
                              <CheckCircle className="size-3" />
                            ) : ["failed", "interrupted"].includes(task.state) ? (
                              <DangerTriangle className="size-3" />
                            ) : null}
                            {taskStateLabel(task)}
                          </Badge></FailureTooltip>
                        </TableCell>
                        <TableCell
                          className={`truncate py-1.5 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
                          title={error}
                        >
                          {error ?? "—"}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs tabular-nums text-muted-foreground">
                          {formatDateTime(task.updatedAt)}
                        </TableCell>
                        <TableCell className="py-1.5 text-right">
                          {["failed", "interrupted"].includes(task.state) &&
                          task.baiduNetdiskUrl ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={pendingAction !== null}
                              onClick={() =>
                                void runAction(
                                  `retry:${task.id}`,
                                  () => wechatMiniProgramCatalogUploadService.retryTask(task.id),
                                  "已重新加入处理队列",
                                )
                              }
                            >
                              重试
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyStateCard
              title="没有符合条件的剧目"
              description="尝试调整关键词或筛选条件"
              action={<Button size="sm" variant="outline" type="button" onClick={resetFilters}>清除筛选</Button>}
            />
          )
        ) : (
          <EmptyStateCard title="还没有剧目入库记录" description="点击右上角获取剧目" />
        )}
        {filteredTasks.length ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>每页</span>
              <CompactSelect
                ariaLabel="每页显示数量"
                className="w-20"
                options={pageSizeOptions.map((size) => ({ value: size, label: `${size} 条` }))}
                value={pageSize}
                onValueChange={setPageSize}
              />
              <span className="tabular-nums">
                第 {(currentPage - 1) * pageSize + 1}–
                {Math.min(currentPage * pageSize, filteredTasks.length)} 条，共{" "}
                {filteredTasks.length} 条
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={currentPage === 1}
                aria-label="首页" title="首页"
                onClick={() => setCurrentPage(1)}
              >
                <ChevronsLeft />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                disabled={currentPage === 1}
                aria-label="上一页" title="上一页"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              >
                <ChevronLeft />
              </Button>
              <span className="min-w-20 text-center tabular-nums text-foreground">
                {currentPage} / {totalPages}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                disabled={currentPage === totalPages}
                aria-label="下一页" title="下一页"
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              >
                <ChevronRight />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={currentPage === totalPages}
                aria-label="末页" title="末页"
                onClick={() => setCurrentPage(totalPages)}
              >
                <ChevronsRight />
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
