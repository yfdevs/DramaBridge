import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { ManagementTableSkeleton } from "@/pages/shared/management-skeleton";
import { managementContentClass } from "@/pages/shared/management-layout";
import { CircleAlertIcon as CircleAlert } from "@/components/ui/solar-icons";
import { FailureTooltip } from "@/components/ui/failure-tooltip";
import { OverflowText } from "@/components/ui/overflow-text";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataSyncDateRange } from "./data-sync-date-range";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { WorkspaceActions, useWorkspacePageActive } from "@/components/workspace-toolbar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/notifications";
import {
  wechatDataSyncService as service,
  type DataSyncState,
  type WeixinChannelsSyncMode,
} from "@/platforms/wechat-drama/data-sync-service";

const initial: DataSyncState = {
  settings: {
    assistantDatePreset: "previous-day",
    assistantUseTestImportSource: false,
    promoteStandardDatePreset: "previous-day",
    promoteDatePreset: "previous-day",
  },
  records: [],
  runningModes: [],
  dryRun: false,
};
const tasks: { mode: WeixinChannelsSyncMode; title: string; description: string }[] = [
  {
    mode: "assistant",
    title: "助手 · 剧集报表",
    description: "下载剧集数据，保存为 Excel",
  },
  {
    mode: "assistant-json",
    title: "助手 · 剧集统计",
    description: "按天获取完整数据，保存为 JSON",
  },
  {
    mode: "promote-standard",
    title: "加热 · 数据报表",
    description: "下载加热明细，保存为 CSV",
  },
];
const presets = [
  ["previous-day", "昨天"],
  ["today", "今天"],
  ["last-7-days", "最近 7 天"],
  ["month-to-date", "本月"],
  ["previous-month", "上月"],
  ["custom", "自定义"],
] as const;

export function WechatDataSyncPage() {
  const navigate = useNavigate();
  const active = useWorkspacePageActive();
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState(initial.settings);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("启动后请按提示逐个扫码登录视频号");
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await service.state();
      setState(next);
      setDraft(next.settings);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const off = service.onEvent((event) => {
      if (disposed) return;
      setMessage(event.message);
      if (event.type === "error") setError(event.message);
      setState((current) => ({
        ...current,
        runningModes:
          event.mode && event.type === "started"
            ? [...new Set([...current.runningModes, event.mode])]
            : event.mode && (event.type === "stopped" || event.type === "error")
              ? current.runningModes.filter((mode) => mode !== event.mode)
              : current.runningModes,
        records: ["imported", "account-failed", "error"].includes(event.type)
          ? [event, ...current.records].slice(0, 200)
          : current.records,
      }));
    });
    void load();
    return () => {
      disposed = true;
      off();
    };
  }, [load]);
  useEffect(() => {
    if (!active) return;
    let disposed = false,
      inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await service.state();
        if (!disposed) {
          setState(next);
          if (next.lastEvent) setMessage(next.lastEvent.message);
        }
      } catch {
        /* Keep the last known state; explicit actions report IPC errors. */
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active]);
  const busy = state.runningModes.length > 0;
  const dirty =
    JSON.stringify({ ...draft, downloadDirectory: undefined }) !==
    JSON.stringify({ ...state.settings, downloadDirectory: undefined });
  async function action(fn: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(text);
      toast.error(text);
    } finally {
      setPending(false);
    }
  }
  function dateControls(group: "assistant" | "promoteStandard", label: string, id: string) {
    const taskLabel = tasks.find((task) => task.mode === id)?.title ?? "数据";
    const presetKey = `${group}DatePreset` as const;
    const rangeKey = `${group}CustomDateRange` as const;
    const range = draft[rangeKey] ?? { startDate: "", endDate: "" };
    return (
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${id}-preset`} className="shrink-0 text-xs text-muted-foreground">
          {label}
        </label>
        <Select
          value={draft[presetKey]}
          disabled={busy || pending || loading}
          onValueChange={(value) => {
            if (value) setDraft({ ...draft, [presetKey]: value });
          }}
        >
          <SelectTrigger id={`${id}-preset`} size="sm" className="min-w-28">
            <SelectValue>{presets.find(([value]) => value === draft[presetKey])?.[1]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {presets.map(([value, text]) => (
              <SelectItem key={value} value={value}>
                {text}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft[presetKey] === "custom" && (
          <DataSyncDateRange
            id={`${id}-range`}
            label={taskLabel}
            value={range}
            disabled={busy || pending || loading}
            onChange={(value) => setDraft({ ...draft, [rangeKey]: value })}
          />
        )}
      </div>
    );
  }
  async function save(mode: WeixinChannelsSyncMode) {
    const group = mode === "promote-standard" ? "promoteStandard" : "assistant";
    const presetKey = `${group}DatePreset` as const;
    const rangeKey = `${group}CustomDateRange` as const;
    const selected = {
      [presetKey]: draft[presetKey],
      [rangeKey]: draft[rangeKey],
      ...(group === "assistant"
        ? { assistantUseTestImportSource: draft.assistantUseTestImportSource }
        : {}),
    };
    if (draft[presetKey] === "custom") {
      const range = draft[rangeKey];
      if (!range?.startDate || !range.endDate || range.endDate < range.startDate)
        throw new Error("请选择有效的开始日期和结束日期");
      if (new Date(`${range.endDate}T00:00:00`) > new Date())
        throw new Error("结束日期不能晚于今天");
    }
    const saved = await service.saveSettings({ ...state.settings, ...selected });
    setDraft((current) => ({ ...current, ...selected }));
    setState((current) => ({ ...current, settings: saved }));
  }

  return (
    <main aria-label="数据同步" className="flex min-w-0 flex-1 flex-col bg-background">
      <WorkspaceActions label="数据同步操作">
        <span className="mr-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {state.dryRun ? "仅保存本地" : "导入后台"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void action(service.openDirectory)}
        >
          下载目录
        </Button>
        <Button size="sm" variant="outline" onClick={() => void navigate("/wechat-drama/config")}>
          后台配置
        </Button>
      </WorkspaceActions>
      <div className={managementContentClass}>
        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 p-3 text-sm text-destructive"
          >
            <span>{error}</span>
            {!busy && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void load()}>
                重试
              </Button>
            )}
          </div>
        )}
        <section aria-label="处理任务" className="divide-y rounded-lg border">
          {tasks.map((task) => {
            const running = state.runningModes.includes(task.mode);
            const assistantBusy =
              task.mode !== "promote-standard" &&
              state.runningModes.some((mode) => mode === "assistant" || mode === "assistant-json");
            return (
              <div
                key={task.mode}
                className="grid gap-3 px-3 py-2.5 @min-[680px]:grid-cols-[180px_minmax(0,1fr)_64px] @min-[680px]:items-center"
              >
                <div>
                  <h2 className="text-sm font-medium">{task.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
                  {dateControls(
                    task.mode === "promote-standard" ? "promoteStandard" : "assistant",
                    "日期",
                    task.mode,
                  )}
                  {task.mode === "assistant-json" && (
                    <p className="text-xs text-muted-foreground">与剧集报表共用日期</p>
                  )}
                  {task.mode === "assistant" && (
                    <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
                      <Switch
                        disabled={busy || pending || loading}
                        checked={draft.assistantUseTestImportSource}
                        onCheckedChange={(checked) =>
                          setDraft({ ...draft, assistantUseTestImportSource: checked })
                        }
                      />
                      使用测试数据源
                    </label>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={running ? "outline" : "default"}
                  disabled={loading || pending || (!running && assistantBusy)}
                  onClick={() =>
                    void action(async () => {
                      if (running) await service.stop(task.mode);
                      else {
                        if (dirty) await save(task.mode);
                        const result = await service.start(task.mode);
                        if (!result.started) setMessage("该任务或共享会话任务正在运行");
                      }
                      const next = await service.state();
                      setState(next);
                    })
                  }
                >
                  {running ? "停止" : "开始"}
                </Button>
              </div>
            );
          })}
        </section>
        <p
          role="status"
          aria-live="polite"
          className="-mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          {pending ? "处理中…" : dirty && !busy ? "设置已修改，开始时自动保存" : message}
        </p>
        <section aria-labelledby="sync-records">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="sync-records" className="text-sm font-medium">
              处理记录{" "}
              <span className="font-normal text-muted-foreground">{state.records.length} 条</span>
            </h2>
            <div className="flex items-center gap-2">
              {confirmClear && (
                <>
                  <span className="text-xs">确认清空本机记录？</span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                    取消
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={pending || busy || !state.records.length}
                onClick={() => {
                  if (!confirmClear) {
                    setConfirmClear(true);
                    return;
                  }
                  void action(async () => {
                    await service.clearRecords();
                    setState((current) => ({ ...current, records: [] }));
                    setConfirmClear(false);
                  });
                }}
              >
                {confirmClear ? "清空" : "清空记录"}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table aria-busy={loading}>
              <TableHeader>
                <TableRow>
                  <TableHead>视频号</TableHead>
                  <TableHead>任务 / 日期</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>完成 / 总数</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody data-skeleton-transition>
                {loading && !state.records.length ? (
                  <ManagementTableSkeleton columns={["w-24", "w-32", "h-4 w-14 rounded-full", "w-10", "w-24"]} rows={4} rowClassName="h-9" />
                ) : !state.records.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="p-3">
                      <EmptyStateCard title="暂无同步记录" description="开始任务后，可在这里查看同步结果" />
                    </TableCell>
                  </TableRow>
                )}
                {state.records.map((record, index) => {
                  const result = record.result as
                    | {
                        data?: {
                          totalCount?: number;
                          successCount?: number;
                          failCount?: number;
                          savedCount?: number;
                          receivedCount?: number;
                          errors?: Array<{
                            rowNumber?: number;
                            columnName?: string;
                            message?: string;
                          }>;
                        };
                      }
                    | undefined;
                  const counts = result?.data;
                  const failed =
                    counts?.failCount ??
                    Math.max(
                      0,
                      (counts?.receivedCount ?? 0) -
                        (counts?.savedCount ?? counts?.receivedCount ?? 0),
                    );
                  const importErrors = counts?.errors
                    ?.slice(0, 3)
                    .map(
                      (error) =>
                        `第 ${error.rowNumber ?? "?"} 行 ${error.columnName ?? ""}：${error.message ?? "导入失败"}`,
                    )
                    .join("；");
                  const label =
                    record.type !== "imported"
                      ? "失败"
                      : record.dryRun
                        ? "已保存 · 未入库"
                        : failed > 0
                          ? "部分失败"
                          : "已导入";
                  const hasFailure = label === "失败" || label === "部分失败";
                  const failureReason = record.failureReason?.trim() || importErrors || record.message || "未返回具体失败原因";
                  return (
                    <TableRow key={`${record.timestamp}-${index}`}>
                      <TableCell className="max-w-48"><OverflowText>{record.accountName ?? "—"}</OverflowText></TableCell>
                      <TableCell className="whitespace-nowrap">
                        {tasks.find((task) => task.mode === record.mode)?.title ?? record.taskName ?? "数据同步"}
                        <span className="ml-2 text-muted-foreground">{record.targetDate ?? "—"}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 ${hasFailure ? "text-destructive" : ""}`}>
                          {label}
                          {hasFailure && (
                            <FailureTooltip reason={failureReason}>
                              <CircleAlert className="size-3.5 shrink-0" />
                              <span className="sr-only">查看失败原因</span>
                            </FailureTooltip>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {record.mode === "assistant-json"
                          ? `${record.fetchedCount ?? "—"} / ${record.totalCount ?? "—"}`
                          : record.dryRun
                            ? "—"
                            : `${counts?.successCount ?? counts?.savedCount ?? "—"} / ${counts?.totalCount ?? counts?.receivedCount ?? "—"}`}
                        {!record.dryRun && failed > 0 && (
                          <span className="ml-2 text-xs text-destructive">失败 {failed} 条</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {record.timestamp
                          ? new Date(record.timestamp).toLocaleString("zh-CN", { hour12: false })
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </main>
  );
}
