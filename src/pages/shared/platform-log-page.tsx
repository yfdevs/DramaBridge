import {
  ArrowDownWaves,
  ChevronDown,
  ChevronRight,
  Folder,
  Pause,
  Play,
  Search,
  Trash,
} from "@mynaui/icons-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { toast } from "sonner";

import { useWorkspacePageActive } from "@/components/workspace-toolbar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PlatformId } from "@/config/navigation";
import { cn } from "@/lib/utils";
import { openAppPlatformLogs } from "@/platforms/app-runtime/service";
import {
  clearPlatformLog,
  subscribeToPlatformLogs,
  type AutomationLogEntry,
  type AutomationLogLevel,
} from "@/platforms/app-runtime/log-service";

type ViewerEntry = AutomationLogEntry & { viewerId: number };
type LevelFilter = "all" | AutomationLogLevel;
type ViewerStatus = "connecting" | "live" | "waiting" | "error";

const MAX_VISIBLE_ENTRIES = 5_000;
const levelLabels: Record<AutomationLogLevel, string> = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
};
const levelTextStyles: Record<AutomationLogLevel, string> = {
  debug: "text-slate-500 dark:text-slate-400",
  info: "text-sky-700 dark:text-sky-300",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-300",
};
const levelDotStyles: Record<AutomationLogLevel, string> = {
  debug: "bg-slate-400",
  info: "bg-sky-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

function appendEntries(current: ViewerEntry[], next: ViewerEntry[]) {
  return [...current, ...next].slice(-MAX_VISIBLE_ENTRIES);
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const base = date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function searchableText(entry: ViewerEntry) {
  return [
    entry.message,
    entry.scope,
    entry.platform,
    entry.error?.code,
    entry.error?.summary,
    entry.error?.stage,
    entry.context ? JSON.stringify(entry.context) : "",
    entry.details ? JSON.stringify(entry.details) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function scopeLabel(scope: string) {
  const segments = scope.split(":");
  return segments[segments.length - 1] || scope;
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ViewerEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = Boolean(entry.error || entry.details || entry.context);
  const metadataDetail = {
    ...(entry.context ? { context: entry.context } : {}),
    ...(entry.details ? { details: entry.details } : {}),
  };
  const hasMetadataDetail = Boolean(entry.context || entry.details);
  const formattedTime = timeLabel(entry.time);
  const [clock, milliseconds] = formattedTime.split(".");
  const rowContent = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-[13px] leading-5 text-foreground">
          {entry.message}
        </span>
        {entry.error?.code && !expanded && (
          <span className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-red-700/85 dark:text-red-300/90">
            {entry.error.code}
            {entry.error.summary && entry.error.summary !== entry.message
              ? ` · ${entry.error.summary}`
              : ""}
          </span>
        )}
      </span>
      <span
        className="truncate text-right font-mono text-[10px] font-medium text-muted-foreground/70"
        title={entry.scope}
      >
        {scopeLabel(entry.scope)}
      </span>
      {expandable ? (
        expanded ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground/60 transition-colors group-hover/row:text-muted-foreground" />
        )
      ) : (
        <span />
      )}
    </>
  );

  return (
    <div
      className={cn(
        "group/row border-b border-border/50 px-3.5 transition-colors last:border-b-0 hover:bg-muted/30",
        entry.level === "error" && "bg-red-500/[0.035] hover:bg-red-500/[0.06]",
      )}
    >
      <div className="grid min-w-0 grid-cols-[76px_48px_minmax(0,1fr)_84px_16px] items-center gap-2 py-2">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
          {clock}
          {milliseconds && (
            <span className="text-[9px] text-muted-foreground/55">.{milliseconds}</span>
          )}
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-[11px] font-medium",
            levelTextStyles[entry.level],
          )}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", levelDotStyles[entry.level])} />
          {levelLabels[entry.level]}
        </span>
        {expandable ? (
          <button
            type="button"
            className="col-span-3 grid min-w-0 grid-cols-[minmax(0,1fr)_84px_16px] items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {rowContent}
          </button>
        ) : (
          <div className="col-span-3 grid min-w-0 grid-cols-[minmax(0,1fr)_84px_16px] items-center gap-2">
            {rowContent}
          </div>
        )}
      </div>
      {expanded && (
        <div className="mr-6 mb-2.5 ml-[140px] overflow-hidden rounded-md bg-muted/45">
          {entry.error && (
            <div
              className={cn(
                "px-3 py-2.5",
                hasMetadataDetail && "border-b border-border/50",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {entry.error.code && (
                  <code className="rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] text-red-700 dark:text-red-300">
                    {entry.error.code}
                  </code>
                )}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {entry.error.stage}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-foreground/85">{entry.error.summary}</p>
              {entry.error.codes && entry.error.codes.length > 1 && (
                <p className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground">
                  {entry.error.codes.join(" → ")}
                </p>
              )}
            </div>
          )}
          {hasMetadataDetail && (
            <pre className="max-h-72 overflow-auto px-3 py-2.5 font-mono text-[11px] leading-[1.55] text-muted-foreground">
              {JSON.stringify(metadataDetail, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PlatformLogViewer({ platform }: { platform: PlatformId }) {
  const [entries, setEntries] = useState<ViewerEntry[]>([]);
  const [status, setStatus] = useState<ViewerStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState("正在连接日志流…");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const currentFileName = filePath?.split(/[\\/]/).pop() ?? "尚未生成日志文件";
  const sequence = useRef(0);
  const pausedRef = useRef(false);
  const pendingRef = useRef<ViewerEntry[]>([]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const identify = (items: AutomationLogEntry[]) =>
    items.map((entry) => ({ ...entry, viewerId: ++sequence.current }));

  useEffect(() => {
    setStatus("connecting");
    setStatusMessage("正在连接日志流…");
    return subscribeToPlatformLogs(platform, {
      onData(event) {
        if (event.type === "snapshot") {
          pendingRef.current = [];
          setPendingCount(0);
          setEntries(identify(event.entries));
          setFilePath(event.filePath);
          setStatus("live");
          setStatusMessage(event.filePath ? "实时监听中" : "等待日志文件");
          return;
        }
        if (event.type === "append") {
          const next = identify(event.entries);
          setFilePath(event.filePath);
          setStatus("live");
          setStatusMessage("实时监听中");
          if (pausedRef.current) {
            pendingRef.current = appendEntries(pendingRef.current, next);
            setPendingCount(pendingRef.current.length);
          } else {
            setEntries((current) => appendEntries(current, next));
          }
          return;
        }
        if (event.type === "reset") {
          pendingRef.current = [];
          setPendingCount(0);
          setEntries([]);
          setFilePath(event.filePath);
          setStatus("live");
          setStatusMessage("日志已清空，继续监听中");
          return;
        }
        if (event.type === "waiting") {
          setStatus("waiting");
          setStatusMessage(event.message);
          return;
        }
        setStatus("error");
        setStatusMessage(event.message);
      },
      onError(message) {
        setStatus("error");
        setStatusMessage(message);
      },
    });
    // identify only relies on the subscription-local sequence ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const filteredEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (level === "all" || entry.level === level) &&
          (!deferredQuery || searchableText(entry).includes(deferredQuery)),
      ),
    [deferredQuery, entries, level],
  );

  const togglePaused = () => {
    if (pausedRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = [];
      pausedRef.current = false;
      setPaused(false);
      setPendingCount(0);
      if (pending.length > 0) setEntries((current) => appendEntries(current, pending));
      return;
    }
    pausedRef.current = true;
    setPaused(true);
  };

  const clearLog = async () => {
    setClearing(true);
    try {
      const result = await clearPlatformLog(platform);
      setConfirmClear(false);
      if (!result.cleared) {
        toast.info("当前还没有可清理的日志文件");
        return;
      }
      pendingRef.current = [];
      setPendingCount(0);
      setEntries([]);
      toast.success("当前日志已清空，实时监听继续运行");
    } catch (error) {
      toast.error("清理日志失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setClearing(false);
    }
  };

  const openFolder = async () => {
    try {
      await openAppPlatformLogs(platform);
    } catch (error) {
      toast.error("无法打开日志目录", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <main className="flex h-full min-h-[480px] flex-col gap-3 px-6 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex min-w-28 max-w-52 shrink items-center gap-2"
          title={`${statusMessage}${filePath ? ` · ${filePath}` : ""}`}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status === "live" && "bg-emerald-500",
              status === "connecting" && "bg-sky-500 motion-safe:animate-pulse",
              status === "waiting" && "bg-amber-500",
              status === "error" && "bg-red-500",
            )}
            role="status"
            aria-label={statusMessage}
          />
          <span
            className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/75"
          >
            {currentFileName}
          </span>
        </div>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 pl-8 text-xs"
            placeholder="搜索账号、任务、范围或错误码"
            aria-label="搜索日志"
          />
        </div>
        <Select value={level} onValueChange={(value) => setLevel(value as LevelFilter)}>
          <SelectTrigger size="sm" className="min-w-24" aria-label="日志级别">
            <SelectValue>{level === "all" ? "全部级别" : levelLabels[level]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="all">全部级别</SelectItem>
            {(["error", "warn", "info", "debug"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {levelLabels[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={paused ? "secondary" : "outline"}
                size="icon-sm"
                aria-label={paused ? "继续刷新日志" : "暂停刷新日志"}
                aria-pressed={paused}
                onClick={togglePaused}
              />
            }
          >
            {paused ? <Play /> : <Pause />}
          </TooltipTrigger>
          <TooltipContent>
            {paused
              ? `继续刷新${pendingCount ? `（有 ${pendingCount} 条新日志）` : ""}`
              : "暂停刷新"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={follow ? "secondary" : "outline"}
                size="icon-sm"
                aria-label={follow ? "关闭跟随底部" : "开启跟随底部"}
                aria-pressed={follow}
                onClick={() => {
                  setFollow((current) => {
                    const next = !current;
                    if (next && filteredEntries.length > 0) {
                      requestAnimationFrame(() =>
                        virtuosoRef.current?.scrollToIndex({
                          index: filteredEntries.length - 1,
                          align: "end",
                        }),
                      );
                    }
                    return next;
                  });
                }}
              />
            }
          >
            <ArrowDownWaves />
          </TooltipTrigger>
          <TooltipContent>{follow ? "关闭跟随底部" : "开启跟随底部"}</TooltipContent>
        </Tooltip>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {filteredEntries.length === entries.length
            ? `${entries.length} 条`
            : `${filteredEntries.length} / ${entries.length} 条`}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="打开日志目录"
                onClick={() => void openFolder()}
              />
            }
          >
            <Folder />
          </TooltipTrigger>
          <TooltipContent>打开日志目录</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="destructive"
                size="icon-sm"
                aria-label="清理当前日志"
                disabled={clearing || !filePath}
                onClick={() => setConfirmClear(true)}
              />
            }
          >
            <Trash />
          </TooltipTrigger>
          <TooltipContent>清理当前日志</TooltipContent>
        </Tooltip>
      </div>

      <section className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card" aria-label="日志内容">
        {filteredEntries.length > 0 ? (
          <Virtuoso
            ref={virtuosoRef}
            data={filteredEntries}
            initialTopMostItemIndex={filteredEntries.length - 1}
            computeItemKey={(_index, entry) => entry.viewerId}
            followOutput={follow ? true : false}
            atBottomStateChange={(atBottom) => {
              if (!atBottom && follow) setFollow(false);
            }}
            itemContent={(_index, entry) => (
              <LogRow
                entry={entry}
                expanded={expanded.has(entry.viewerId)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(entry.viewerId)) next.delete(entry.viewerId);
                    else next.add(entry.viewerId);
                    return next;
                  })
                }
              />
            )}
          />
        ) : (
          <div className="flex h-full min-h-64 flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium">
              {entries.length > 0 ? "没有匹配的日志" : "暂无日志"}
            </p>
            <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              {entries.length > 0
                ? "调整搜索词或日志级别即可恢复显示。"
                : status === "waiting"
                  ? "平台开始运行后，新日志会自动出现在这里。"
                  : "正在读取最近 100 条记录并建立实时连接。"}
            </p>
          </div>
        )}
      </section>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空当前日志文件？</AlertDialogTitle>
            <AlertDialogDescription>
              文件内容会被永久清空，但实时监听不会停止，后续产生的新日志仍会继续显示。其他平台和历史日期的日志不会受到影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={clearing}
              onClick={(event) => {
                event.preventDefault();
                void clearLog();
              }}
            >
              {clearing ? "正在清理…" : "确认清空"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

export function PlatformLogPage({ platform }: { platform: PlatformId }) {
  const active = useWorkspacePageActive();
  return active ? <PlatformLogViewer platform={platform} /> : null;
}
