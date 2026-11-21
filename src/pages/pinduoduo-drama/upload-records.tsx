import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { ManagementTableSkeleton } from "@/pages/shared/management-skeleton";
import { FailureTooltip } from "@/components/ui/failure-tooltip";
import { OverflowText } from "@/components/ui/overflow-text";
import { useCallback, useEffect, useState } from "react";
import { RefreshIcon as Refresh } from "@/components/ui/solar-icons";
import { toast } from "@/components/ui/notifications";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterToolbar } from "@/components/filter-controls";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { cn } from "@/lib/utils";
import {
  pinduoduoDramaService,
  type PinduoduoUploadRecord,
  type PinduoduoUploadRecordsSummary,
} from "@/platforms/pinduoduo-drama/service";

type StatusFilter = "all" | "PENDING" | "IN_PROGRESS" | "UPLOADED" | "FAILED";

const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "PENDING", label: "待处理" },
  { value: "IN_PROGRESS", label: "进行中" },
  { value: "UPLOADED", label: "已上传" },
  { value: "FAILED", label: "失败" },
];

function statusQueryValue(filter: StatusFilter) {
  switch (filter) {
    case "all":
      return undefined;
    case "IN_PROGRESS":
      return "DOWNLOADING,READY,UPLOADING";
    case "FAILED":
      return "FAILED,REJECTED,CONFIRM_REQUIRED";
    default:
      return filter;
  }
}

function isInProgress(status: string | undefined) {
  return status === "DOWNLOADING" || status === "READY" || status === "UPLOADING";
}

function statusText(status: string | undefined) {
  switch (status) {
    case "PENDING":
      return "待处理";
    case "DOWNLOADING":
      return "下载中";
    case "READY":
      return "待上传";
    case "UPLOADING":
      return "上传中";
    case "UPLOADED":
      return "已上传";
    case "FAILED":
      return "失败";
    case "REJECTED":
      return "平台拒绝";
    case "CONFIRM_REQUIRED":
      return "待确认";
    default:
      return "未知";
  }
}

function stageText(stage: string | undefined) {
  switch (stage) {
    case "DOWNLOAD":
      return "下载";
    case "OPEN_PAGE":
      return "打开页面";
    case "UPLOAD":
      return "上传";
    case "VERIFY":
      return "校验";
    case "BIND":
      return "绑定短剧";
    case "PUBLISH":
      return "发布";
    default:
      return stage ?? "";
  }
}

function failureReason(record: PinduoduoUploadRecord) {
  if (!["FAILED", "REJECTED", "CONFIRM_REQUIRED"].includes(record.status ?? "")) return "—";
  const stage = stageText(record.stage);
  const message = record.errorMessage?.trim() ?? "";
  if (stage && message) return `${stage}：${message}`;
  return stage || message || "—";
}

function resourceSourceText(record: PinduoduoUploadRecord) {
  if (record.resourceSource === "FEISHU") return "飞书全集来源表";
  if (record.resourceSource === "LEGACY_XLSX_ORIGINAL") return "历史表原链接";
  if (record.resourceSource === "PINDUODUO_LIST") return "拼多多列表链接";
  return "待解析";
}

function resourceSourceTitle(record: PinduoduoUploadRecord) {
  const rows = record.resourceSourceRows;
  if (record.resourceSource === "LEGACY_XLSX_ORIGINAL" && rows?.length) {
    return `拼多多传剧表.xlsx，第 ${rows.join("、")} 行`;
  }
  return resourceSourceText(record);
}

function formatDateTime(value: string | undefined) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string | undefined }) {
  if (status === "UPLOADED") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        {statusText(status)}
      </Badge>
    );
  }
  if (status === "FAILED" || status === "REJECTED" || status === "CONFIRM_REQUIRED") {
    return <Badge variant="destructive">{statusText(status)}</Badge>;
  }
  if (isInProgress(status)) {
    return (
      <Badge
        variant="secondary"
        className="bg-sky-500/10 text-sky-700 dark:text-sky-300"
      >
        {statusText(status)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {statusText(status)}
    </Badge>
  );
}

const emptySummary: PinduoduoUploadRecordsSummary = {
  total: 0,
  pending: 0,
  uploading: 0,
  uploaded: 0,
  failed: 0,
};

export function PinduoduoDramaUploadRecordsPage() {
  const [records, setRecords] = useState<PinduoduoUploadRecord[]>([]);
  const [summary, setSummary] = useState<PinduoduoUploadRecordsSummary>(emptySummary);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryingRecordId, setRetryingRecordId] = useState<number | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);

      try {
        const result = await pinduoduoDramaService.listUploadRecords({
          status: statusQueryValue(statusFilter),
          limit: 200,
        });
        setRecords(result.records);
        setSummary(result.summary);
        setLastRefreshedAt(new Date());
      } catch (error) {
        if (!silent) {
          toast.error("上传记录加载失败", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    void refresh();

    const refreshInterval = window.setInterval(() => {
      void refresh(true);
    }, 30_000);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [refresh]);

  const handleRetryFailed = () => {
    void (async () => {
      setRetrying(true);

      try {
        const { reset } = await pinduoduoDramaService.retryFailedUploadRecords();
        if (reset > 0) {
          toast.success("已重新加入待处理队列", {
            description: `共重置 ${reset} 条失败记录，服务会在下一轮自动重试`,
          });
        } else {
          toast.info("没有需要重试的失败记录");
        }
        await refresh(true);
      } catch (error) {
        toast.error("重试失败记录出错", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setRetrying(false);
      }
    })();
  };

  const handleRetryRecord = (record: PinduoduoUploadRecord) => {
    void (async () => {
      setRetryingRecordId(record.platformApplyId);

      try {
        const { reset } = await pinduoduoDramaService.retryUploadRecord(record.platformApplyId, record.accountProfileName ?? "");
        if (reset > 0) {
          toast.success(`《${record.title}》已加入待处理队列`, {
            description: "服务会在下一轮自动重试这部剧",
          });
        } else {
          toast.info(`《${record.title}》当前不需要重试`);
        }
        await refresh(true);
      } catch (error) {
        toast.error(`《${record.title}》重试失败`, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setRetryingRecordId(null);
      }
    })();
  };

  const handleConfirmPublication = async (record: PinduoduoUploadRecord, published: boolean) => {
    const result = published ? "已发布" : "未发布";
    if (!window.confirm(`请先核对拼多多平台。确认“${record.accountProfileName} / ${record.title}”上次提交的这一批${result}？`)) return;
    setRetryingRecordId(record.platformApplyId);
    try {
      await pinduoduoDramaService.confirmPublication(record.accountProfileName ?? "", record.platformApplyId, published);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingRecordId(null);
    }
  };

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-transparent font-workspace text-sm [&_[data-slot=button]]:text-xs">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col">
        <header className="shrink-0 border-b bg-background p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-baseline gap-2">
                <h1 className="text-sm font-medium">审核与上传状态</h1>
                <span className="text-xs tabular-nums text-muted-foreground">
                  共 {summary.total} 部
                </span>
              </div>
              <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
                服务按配置周期同步拼多多审核列表，任务与进度保存在飞书，本窗口每 30 秒刷新
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">
                {lastRefreshedAt
                  ? `${lastRefreshedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 已刷新`
                  : "等待刷新"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <Refresh className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
                {loading ? "刷新中" : "刷新"}
              </Button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-y py-2 text-xs text-muted-foreground">
            <span>
              待处理 <strong className="ml-1 font-medium tabular-nums text-foreground">{summary.pending}</strong>
            </span>
            <span>
              进行中 <strong className="ml-1 font-medium tabular-nums text-sky-700 dark:text-sky-300">{summary.uploading}</strong>
            </span>
            <span>
              已上传 <strong className="ml-1 font-medium tabular-nums text-emerald-700 dark:text-emerald-300">{summary.uploaded}</strong>
            </span>
            <span>
              失败{" "}
              <strong
                className={cn(
                  "ml-1 font-medium tabular-nums",
                  summary.failed > 0 ? "text-destructive" : "text-foreground",
                )}
              >
                {summary.failed}
              </strong>
            </span>
          </div>

          <FilterToolbar label="记录筛选" className="mt-3 justify-between">
            <ListFilterMenu
              label="筛选记录"
              groups={[{
                key: "status",
                label: "上传状态",
                value: statusFilter,
                defaultValue: "all",
                options: statusOptions,
                onChange: (value) => setStatusFilter(value as StatusFilter),
              }]}
            />
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={retrying || retryingRecordId !== null || summary.failed === 0}
              onClick={handleRetryFailed}
            >
              {retrying
                ? "正在重试…"
                : `重试失败任务${summary.failed > 0 ? `（${summary.failed}）` : ""}`}
            </Button>
          </FilterToolbar>
        </header>

        <section className="min-h-0 flex-1 p-3" data-skeleton-transition>
          {records.length > 0 || loading ? (
            <div className="h-full min-h-0 overflow-hidden bg-background">
              <Table stickyActions aria-busy={loading}
                containerClassName="h-full overflow-auto overscroll-contain"
                className="min-w-[1160px] table-fixed"
              >
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead className="h-8">剧名</TableHead>
                  <TableHead className="h-8 w-20">状态</TableHead>
                  <TableHead className="h-8 w-32">资源来源</TableHead>
                  <TableHead className="h-8 w-44">失败原因</TableHead>
                  <TableHead className="h-8 w-20 text-right">尝试次数</TableHead>
                  <TableHead className="h-8 w-28 text-right">审核通过时间</TableHead>
                  <TableHead className="h-8 w-28 text-right">上传完成时间</TableHead>
                  <TableHead className="h-8 w-28 text-right">最近更新</TableHead>
                  <TableHead className="h-8 w-48 text-left">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && !records.length && (
                  <ManagementTableSkeleton
                    columns={["w-3/4 max-w-40", "h-4 w-12 rounded-full", "w-20", "w-3/4", "ml-auto w-6", "ml-auto w-16", "ml-auto w-16", "ml-auto w-16", "h-5 w-16"]}
                    rowClassName="h-9"
                  />
                )}
                {records.map((record) => (
                  <TableRow key={`${record.accountProfileName}:${record.platformApplyId}`} className="h-9">
                    <TableCell className="max-w-0 py-1.5">
                      <div className="flex min-w-0 items-center gap-2" title={[record.title, record.episodeCount ? `${record.episodeCount} 集` : "集数未知", record.accountProfileName].filter(Boolean).join(" · ")}>
                      <OverflowText as="div" className="min-w-0 truncate text-xs font-medium">
                        {record.title}
                      </OverflowText>
                      <OverflowText as="div" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {record.episodeCount ? `共 ${record.episodeCount} 集` : "集数未知"}
                        {record.accountProfileName ? `，${record.accountProfileName}` : ""}
                      </OverflowText>
                      </div>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <FailureTooltip reason={["FAILED", "REJECTED"].includes(record.status ?? "") ? failureReason(record) : undefined}><StatusBadge status={record.status} /></FailureTooltip>
                    </TableCell>
                    <TableCell className="max-w-0 py-1.5">
                      <OverflowText as="div"
                        className="truncate text-xs text-muted-foreground"
                        title={resourceSourceTitle(record)}
                      >
                        {resourceSourceText(record)}
                      </OverflowText>
                    </TableCell>
                    <TableCell className="max-w-0 py-1.5">
                      <OverflowText as="div"
                        className={cn(
                          "truncate text-xs text-muted-foreground",
                          (record.status === "FAILED" || record.status === "REJECTED") &&
                            "text-destructive",
                        )}
                        title={failureReason(record)}
                      >
                        {failureReason(record)}
                      </OverflowText>
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                      {record.attempts ?? 0}
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(record.createdAt)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(record.uploadedAt)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(record.updatedAt)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      {record.status === "CONFIRM_REQUIRED" ? (
                        <div className="flex items-center justify-start gap-1">
                          <Button size="sm" variant="outline" disabled={retryingRecordId !== null} onClick={() => void handleConfirmPublication(record, true)}>该批已发布</Button>
                          <Button size="sm" variant="outline" disabled={retryingRecordId !== null} onClick={() => void handleConfirmPublication(record, false)}>该批未发布</Button>
                        </div>
                      ) : record.status === "FAILED" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={retrying || retryingRecordId !== null}
                          onClick={() => handleRetryRecord(record)}
                        >
                          {retryingRecordId === record.platformApplyId ? "重试中…" : "重试此剧"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyStateCard
              className="h-full min-h-48"
              title="暂无上传记录"
              description="启动拼多多服务后，将自动同步审核通过的短剧"
            />
          )}
        </section>
      </div>
    </main>
  );
}
