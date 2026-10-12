import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, DangerTriangle } from "@mynaui/icons-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
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
      <SelectTrigger className={className} size="sm" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={String(option.value)}
              value={option.value}
              className="min-h-8 px-2 py-1.5 pr-8 text-xs"
            >
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
      if (coverFilter === "pending" && (isCoverComplete || task.coverStatus === "failed")) return false;
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
  const hasFilters =
    Boolean(keyword.trim()) ||
    stateFilter !== "all" ||
    episodeFilter !== "all" ||
    coverFilter !== "all" ||
    sourceFilter !== "all";

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

  if (loading && !workspace) {
    return (
      <main className="grid h-full place-items-center bg-background text-sm text-muted-foreground">
        <Spinner /> 正在读取入库记录
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <img
                alt=""
                className="size-5"
                src={`${import.meta.env.BASE_URL}wechat-miniprogram.svg`}
              />
              <h1 className="text-base font-semibold">剧目前四集与封面入库</h1>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pendingAction !== null || Boolean(workspace?.queue.running)}
              onClick={() =>
                void runAction(
                  "sync",
                  wechatMiniProgramCatalogUploadService.syncCatalog,
                  "全部剧目和后台状态已更新",
                )
              }
            >
              {pendingAction === "sync" || workspace?.sync.running ? <Spinner /> : null}
              {workspace?.sync.running ? "正在获取全部剧目" : "获取全部剧目"}
            </Button>
            <Button
              size="sm"
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
              {pendingAction === "retry-all" ? <Spinner /> : null}
              重试全部{retryableTasks.length ? ` (${retryableTasks.length})` : ""}
            </Button>
            <Button
              size="sm"
              variant={workspace?.queue.running ? "outline" : "default"}
              disabled={pendingAction !== null || Boolean(workspace?.sync.running)}
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
              {pendingAction === "queue" ? <Spinner /> : null}
              {workspace?.queue.running ? "暂停接续" : "开始处理"}
            </Button>
            {workspace?.queue.activeTaskId ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pendingAction !== null}
                onClick={() =>
                  void runAction("cancel", wechatMiniProgramCatalogUploadService.cancelActiveTask)
                }
              >
                终止当前剧目
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs">
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
              : `剧目 ${workspace?.tasks.length ?? 0} 部${workspace?.sync.lastSyncedAt ? ` · 更新于 ${formatDateTime(workspace.sync.lastSyncedAt)}` : ""}`}
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
            <span className="max-w-96 truncate text-destructive" title={workspace.queue.error}>
              {workspace.queue.error}
            </span>
          ) : null}
          {workspace?.sync.error ? (
            <span className="max-w-96 truncate text-destructive" title={workspace.sync.error}>
              {workspace.sync.error}
            </span>
          ) : null}
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
        <div
          className="flex shrink-0 flex-wrap items-center gap-2"
          role="search"
          aria-label="筛选剧目"
        >
          <Input
            className="h-7 w-full text-xs sm:w-64"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索剧名、剧 ID 或网盘链接"
            aria-label="搜索剧目"
          />
          <CompactSelect
            ariaLabel="任务状态筛选"
            className="w-36"
            options={stateFilterOptions}
            value={stateFilter}
            onValueChange={setStateFilter}
          />
          <CompactSelect
            ariaLabel="前四集状态筛选"
            className="w-36"
            options={episodeFilterOptions}
            value={episodeFilter}
            onValueChange={setEpisodeFilter}
          />
          <CompactSelect
            ariaLabel="封面状态筛选"
            className="w-32"
            options={coverFilterOptions}
            value={coverFilter}
            onValueChange={setCoverFilter}
          />
          <CompactSelect
            ariaLabel="网盘资源筛选"
            className="w-36"
            options={sourceFilterOptions}
            value={sourceFilter}
            onValueChange={setSourceFilter}
          />
          {hasFilters ? (
            <Button type="button" size="xs" variant="ghost" onClick={resetFilters}>
              清除筛选
            </Button>
          ) : null}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            显示 {filteredTasks.length} / {workspace?.tasks.length ?? 0} 部
          </span>
        </div>
        {workspace?.tasks.length ? (
          filteredTasks.length ? (
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
              <Table
                containerClassName="h-full overflow-auto overscroll-contain"
                className="min-w-[1450px] table-fixed"
              >
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow className="bg-muted/80 hover:bg-muted/80">
                    <TableHead className="h-9 w-20">剧 ID</TableHead>
                    <TableHead className="h-9 w-24">微信 ID</TableHead>
                    <TableHead className="h-9 w-52">剧目</TableHead>
                    <TableHead className="h-9 w-16 text-right">总集数</TableHead>
                    <TableHead className="h-9 w-28">网盘资源</TableHead>
                    <TableHead className="h-9 w-32">前四集</TableHead>
                    <TableHead className="h-9 w-32">封面</TableHead>
                    <TableHead className="h-9 w-28">生命周期</TableHead>
                    <TableHead className="h-9 w-24">发布状态</TableHead>
                    <TableHead className="h-9 w-32">处理状态</TableHead>
                    <TableHead className="h-9 w-56">异常信息</TableHead>
                    <TableHead className="h-9 w-28">最近更新</TableHead>
                    <TableHead className="h-9 w-20 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedTasks.map((task) => {
                    const active = workspace.queue.activeTaskId === task.id;
                    const episodeComplete = episodesComplete(task);
                    const episodeFailed = episodesFailed(task);
                    const isCoverComplete = coverComplete(task);
                    const episodeError = task.episodeStatuses.find(
                      (episode) => episode.state === "failed",
                    )?.error;
                    const error = task.error ?? task.coverError ?? episodeError;
                    return (
                      <TableRow key={task.id} className={active ? "bg-sky-500/5" : undefined}>
                        <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                          {task.dramaId}
                        </TableCell>
                        <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                          {task.wxDramaId ?? "—"}
                        </TableCell>
                        <TableCell className="min-w-0 py-2">
                          <div className="truncate font-medium" title={task.dramaName}>
                            {task.dramaName}
                          </div>
                        </TableCell>
                        <TableCell className="py-2 text-right text-xs tabular-nums">
                          {task.episodeCount}
                        </TableCell>
                        <TableCell className="py-2">
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
                        <TableCell className="py-2">
                          <div className="grid gap-0.5 text-xs">
                            <span
                              className={
                                episodeComplete
                                  ? "text-emerald-700 dark:text-emerald-300"
                                  : episodeFailed
                                    ? "text-destructive"
                                    : "text-foreground"
                              }
                            >
                              {episodeComplete
                                ? "已入库"
                                : episodeFailed
                                  ? "上传失败"
                                  : "待入库"}
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                              {Math.min(task.uploadedEpisodeCount, task.targetEpisodeCount)}/
                              {task.targetEpisodeCount} 集
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="grid min-w-0 gap-0.5 text-xs">
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
                            <span
                              className="truncate text-muted-foreground"
                              title={task.coverFileName}
                            >
                              {task.coverStatus === "existing" || task.hasCover
                                ? "后台已有"
                                : task.coverStatus === "uploaded"
                                  ? task.coverFileName ?? "本次上传"
                                  : "—"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="truncate py-2 text-xs" title={task.lifecycleStatus}>
                          {lifecycleLabel(task.lifecycleStatus)}
                        </TableCell>
                        <TableCell
                          className="truncate py-2 text-xs"
                          title={task.actualPublishStatus}
                        >
                          {publishStatusLabels[task.actualPublishStatus ?? ""] ??
                            task.actualPublishStatus ??
                            "—"}
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge
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
                          </Badge>
                        </TableCell>
                        <TableCell
                          className={`truncate py-2 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
                          title={error}
                        >
                          {error ?? "—"}
                        </TableCell>
                        <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                          {formatDateTime(task.updatedAt)}
                        </TableCell>
                        <TableCell className="py-2 text-right">
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
            <div className="grid min-h-0 flex-1 place-items-center rounded-lg border border-dashed px-6 text-center">
              <div className="max-w-sm">
                <h2 className="text-sm font-medium">没有符合条件的剧目</h2>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  尝试调整关键词或筛选条件。
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={resetFilters}
                >
                  清除筛选
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center rounded-lg border border-dashed px-6 text-center">
            <div className="max-w-md">
              <h2 className="text-sm font-medium">还没有剧目入库记录</h2>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                点击“获取全部剧目”，系统会一次操作自动读取全部分页，并统一更新剧目和后台状态。
              </p>
            </div>
          </div>
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
                size="xs"
                variant="ghost"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(1)}
              >
                首页
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              >
                上一页
              </Button>
              <span className="min-w-20 text-center tabular-nums text-foreground">
                {currentPage} / {totalPages}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              >
                下一页
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(totalPages)}
              >
                末页
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
