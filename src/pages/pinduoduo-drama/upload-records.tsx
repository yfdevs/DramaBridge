import { useCallback, useEffect, useState } from "react";
import { Refresh } from "@mynaui/icons-react";
import { toast } from "sonner";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  pinduoduoDramaService,
  type PinduoduoUploadRecord,
  type PinduoduoUploadRecordsSummary,
} from "@/platforms/pinduoduo-drama/service";

type StatusTab = "all" | "PENDING" | "IN_PROGRESS" | "UPLOADED" | "FAILED";

const statusTabs: Array<{ value: StatusTab; label: string }> = [
  { value: "all", label: "全部" },
  { value: "PENDING", label: "待处理" },
  { value: "IN_PROGRESS", label: "进行中" },
  { value: "UPLOADED", label: "已上传" },
  { value: "FAILED", label: "失败" },
];

function statusFilterForTab(tab: StatusTab) {
  switch (tab) {
    case "all":
      return undefined;
    case "IN_PROGRESS":
      return "DOWNLOADING,READY,UPLOADING";
    case "FAILED":
      return "FAILED,REJECTED";
    default:
      return tab;
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
  if (record.status !== "FAILED" && record.status !== "REJECTED") return "—";
  const stage = stageText(record.stage);
  const message = record.errorMessage?.trim() ?? "";
  if (stage && message) return `${stage}：${message}`;
  return stage || message || "—";
}

function resourceSourceText(record: PinduoduoUploadRecord) {
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
  if (status === "FAILED" || status === "REJECTED") {
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
  const [activeTab, setActiveTab] = useState<StatusTab>("all");
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryingRecordId, setRetryingRecordId] = useState<number | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);

      try {
        const result = await pinduoduoDramaService.listUploadRecords({
          status: statusFilterForTab(activeTab),
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
    [activeTab],
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
        const { reset } = await pinduoduoDramaService.retryUploadRecord(record.platformApplyId);
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

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col">
        <header className="shrink-0 border-b bg-background/80 px-6 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-baseline gap-2">
                <h1 className="text-lg font-semibold tracking-normal">审核与上传状态</h1>
                <span className="text-xs tabular-nums text-muted-foreground">
                  共 {summary.total} 部
                </span>
              </div>
              <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
                服务按配置周期同步拼多多审核列表，本窗口每 30 秒刷新下载与上传进度
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] tabular-nums text-muted-foreground">
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

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-y py-2.5 text-xs text-muted-foreground">
            <span>
              待处理 <strong className="ml-1 font-semibold tabular-nums text-foreground">{summary.pending}</strong>
            </span>
            <span>
              进行中 <strong className="ml-1 font-semibold tabular-nums text-sky-700">{summary.uploading}</strong>
            </span>
            <span>
              已上传 <strong className="ml-1 font-semibold tabular-nums text-emerald-700">{summary.uploaded}</strong>
            </span>
            <span>
              失败{" "}
              <strong
                className={cn(
                  "ml-1 font-semibold tabular-nums",
                  summary.failed > 0 ? "text-destructive" : "text-foreground",
                )}
              >
                {summary.failed}
              </strong>
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(String(value ?? "all") as StatusTab)}
            >
              <TabsList>
                {statusTabs.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value} className="px-3 text-xs">
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={retrying || retryingRecordId !== null || summary.failed === 0}
              onClick={handleRetryFailed}
            >
              {retrying
                ? "正在重试…"
                : `全部重试失败${summary.failed > 0 ? `（${summary.failed}）` : ""}`}
            </Button>
          </div>
        </header>

        <section className="min-h-0 flex-1 p-6 pt-4">
          {records.length > 0 ? (
            <div className="h-full min-h-0 overflow-hidden rounded-lg border bg-background">
              <Table
                containerClassName="h-full overflow-auto overscroll-contain"
                className="min-w-[1160px] table-fixed"
              >
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow className="bg-muted/80 hover:bg-muted/80">
                  <TableHead className="h-8">剧名</TableHead>
                  <TableHead className="h-8 w-20">状态</TableHead>
                  <TableHead className="h-8 w-32">资源来源</TableHead>
                  <TableHead className="h-8 w-44">失败原因</TableHead>
                  <TableHead className="h-8 w-20 text-right">尝试次数</TableHead>
                  <TableHead className="h-8 w-28 text-right">审核通过时间</TableHead>
                  <TableHead className="h-8 w-28 text-right">上传完成时间</TableHead>
                  <TableHead className="h-8 w-28 text-right">最近更新</TableHead>
                  <TableHead className="h-8 w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.platformApplyId} className="h-12">
                    <TableCell className="max-w-0 py-2">
                      <div className="truncate text-xs font-medium" title={record.title}>
                        {record.title}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {record.episodeCount ? `共 ${record.episodeCount} 集` : "集数未知"}
                        {record.accountProfileName ? `，${record.accountProfileName}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <StatusBadge status={record.status} />
                    </TableCell>
                    <TableCell className="max-w-0 py-2">
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={resourceSourceTitle(record)}
                      >
                        {resourceSourceText(record)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-0 py-2">
                      <div
                        className={cn(
                          "truncate text-xs text-muted-foreground",
                          (record.status === "FAILED" || record.status === "REJECTED") &&
                            "text-destructive",
                        )}
                        title={failureReason(record)}
                      >
                        {failureReason(record)}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground">
                      {record.attempts ?? 0}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[11px] tabular-nums text-muted-foreground">
                      {formatDateTime(record.createdAt)}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[11px] tabular-nums text-muted-foreground">
                      {formatDateTime(record.uploadedAt)}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[11px] tabular-nums text-muted-foreground">
                      {formatDateTime(record.updatedAt)}
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      {record.status === "FAILED" ? (
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
            <div className="grid h-full min-h-48 place-items-center rounded-lg border border-dashed bg-background/60 px-6 text-center">
              <div>
                <div className="text-sm font-medium">
                  {loading ? "正在加载上传记录…" : "暂无上传记录"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {loading ? "请稍候" : "启动拼多多服务后，将自动同步审核通过的短剧"}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
