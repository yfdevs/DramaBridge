import { ChevronDown, ChevronRight, Folder, Pause, Play, Search, Trash } from "@mynaui/icons-react";
import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { toast } from "@/components/ui/notifications";

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
import { CodeOutput } from "@/components/code-output";
import { ArrowDownIcon, XIcon } from "lucide-react";
import { ListFilterMenu } from "@/components/list-filter-menu";
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
const APPEND_BATCH_INTERVAL_MS = 120;
const searchableTextCache = new WeakMap<ViewerEntry, string>();
const levelLabels: Record<AutomationLogLevel, string> = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
};
const levelTextStyles: Record<AutomationLogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-[var(--log-info)]",
  warn: "text-[var(--log-warn)]",
  error: "text-[var(--log-error)]",
};
const levelDotStyles: Record<AutomationLogLevel, string> = {
  debug: "bg-muted-foreground",
  info: "bg-[var(--log-info)]",
  warn: "bg-[var(--log-warn)]",
  error: "bg-[var(--log-error)]",
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
  const cached = searchableTextCache.get(entry);
  if (cached !== undefined) return cached;
  const text = [
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
  searchableTextCache.set(entry, text);
  return text;
}

function scopeLabel(scope: string) {
  const segments = scope.split(":");
  return segments[segments.length - 1] || scope;
}

const LogRow = memo(function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ViewerEntry;
  expanded: boolean;
  onToggle: (viewerId: number) => void;
}) {
  const expandable = Boolean(entry.error || entry.details || entry.context);
  const metadataDetail = {
    ...(entry.context ? { context: entry.context } : {}),
    ...(entry.details ? { details: entry.details } : {}),
  };
  const hasMetadataDetail = Boolean(entry.context || entry.details);
  const formattedTime = timeLabel(entry.time);
  const [clock] = formattedTime.split(".");
  const rowContent = (
    <>
      <span className="min-w-0">
        <span className="line-clamp-2 break-words whitespace-pre-wrap text-xs leading-5 text-foreground">
          {entry.message}
        </span>
        {entry.error?.code && !expanded && (
          <span className="mt-0.5 block truncate font-mono text-xs leading-4 text-[var(--log-error)]">
            {entry.error.code}
            {entry.error.summary && entry.error.summary !== entry.message
              ? `，${entry.error.summary}`
              : ""}
          </span>
        )}
      </span>
      <span
        className="hidden truncate text-right font-mono text-xs font-medium text-muted-foreground/70 @min-[650px]:block"
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
        "group/row px-3 hover:bg-muted/30",
        entry.level === "error" && "bg-[var(--log-error-bg)]",
      )}
    >
      <div className="grid min-w-0 grid-cols-[64px_48px_minmax(0,1fr)] items-center gap-2 py-2">
        <time
          dateTime={entry.time}
          title={entry.time}
          className="font-mono text-xs tabular-nums text-muted-foreground/80"
        >
          {clock}
        </time>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
            levelTextStyles[entry.level],
          )}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", levelDotStyles[entry.level])} />
          {levelLabels[entry.level]}
        </span>
        {expandable ? (
          <button
            type="button"
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_16px] @min-[650px]:grid-cols-[minmax(0,1fr)_84px_16px] items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-expanded={expanded}
            onClick={() => onToggle(entry.viewerId)}
          >
            {rowContent}
          </button>
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_16px] @min-[650px]:grid-cols-[minmax(0,1fr)_84px_16px] items-center gap-2">
            {rowContent}
          </div>
        )}
      </div>
      {expanded && (
        <div className="mb-3 ml-0 sm:ml-[140px] overflow-hidden rounded-md bg-muted/45">
          {entry.error && (
            <div className={cn("px-3 py-2.5", hasMetadataDetail && "")}>
              <div className="flex flex-wrap items-center gap-1.5">
                {entry.error.code && (
                  <code className="rounded bg-[var(--log-error)]/10 px-1.5 py-0.5 font-mono text-xs text-[var(--log-error)]">
                    {entry.error.code}
                  </code>
                )}
                <span className="font-mono text-xs text-muted-foreground">{entry.error.stage}</span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-foreground/85">{entry.error.summary}</p>
              {entry.error.codes && entry.error.codes.length > 1 && (
                <p className="mt-1 font-mono text-xs leading-4 text-muted-foreground">
                  {entry.error.codes.join(" → ")}
                </p>
              )}
            </div>
          )}
          {hasMetadataDetail && (
            <CodeOutput title="日志数据" value={JSON.stringify(metadataDetail, null, 2)} />
          )}
        </div>
      )}
    </div>
  );
});

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
  const appendBufferRef = useRef<ViewerEntry[]>([]);
  const appendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pointerScrollingRef = useRef(false);
  const [lastSeenId, setLastSeenId] = useState(0);

  const identify = useCallback(
    (items: AutomationLogEntry[]) =>
      items.map((entry) => ({ ...entry, viewerId: ++sequence.current })),
    [],
  );

  const cancelAppendBatch = useCallback(() => {
    if (appendTimerRef.current !== null) clearTimeout(appendTimerRef.current);
    appendTimerRef.current = null;
    appendBufferRef.current = [];
  }, []);

  const flushAppendBatch = useCallback(() => {
    if (appendTimerRef.current !== null) clearTimeout(appendTimerRef.current);
    appendTimerRef.current = null;
    const batch = appendBufferRef.current;
    appendBufferRef.current = [];
    if (batch.length === 0) return;
    startTransition(() => {
      setEntries((current) => appendEntries(current, batch));
    });
  }, []);

  const queueAppendBatch = useCallback(
    (items: ViewerEntry[]) => {
      appendBufferRef.current.push(...items);
      if (appendTimerRef.current !== null) return;
      appendTimerRef.current = setTimeout(flushAppendBatch, APPEND_BATCH_INTERVAL_MS);
    },
    [flushAppendBatch],
  );

  useEffect(() => {
    setStatus("connecting");
    setStatusMessage("正在连接日志流…");
    const unsubscribe = subscribeToPlatformLogs(platform, {
      onData(event) {
        if (event.type === "snapshot") {
          cancelAppendBatch();
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
            queueAppendBatch(next);
          }
          return;
        }
        if (event.type === "reset") {
          cancelAppendBatch();
          pendingRef.current = [];
          setPendingCount(0);
          setEntries([]);
          setFilePath(event.filePath);
          setStatus("live");
          setStatusMessage("日志已清空，等待新日志");
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
    return () => {
      unsubscribe();
      cancelAppendBatch();
    };
  }, [cancelAppendBatch, identify, platform, queueAppendBatch]);

  const filteredEntries = useMemo(() => {
    if (level === "all" && !deferredQuery) return entries;
    return entries.filter(
      (entry) =>
        (level === "all" || entry.level === level) &&
        (!deferredQuery || searchableText(entry).includes(deferredQuery)),
    );
  }, [deferredQuery, entries, level]);
  useEffect(() => {
    if (follow && !paused) setLastSeenId(entries[entries.length - 1]?.viewerId ?? 0);
  }, [entries, follow, paused]);
  const unread = follow ? 0 : filteredEntries.filter((entry) => entry.viewerId > lastSeenId).length;
  useEffect(() => {
    if (!follow || paused || !filteredEntries.length) return;
    const frame = requestAnimationFrame(() =>
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [follow, paused, filteredEntries]);
  const followLatest = () => {
    if (pausedRef.current) togglePaused();
    setFollow(true);
    requestAnimationFrame(() =>
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" }),
    );
  };

  const toggleExpanded = useCallback((viewerId: number) => {
    setFollow(false);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(viewerId)) next.delete(viewerId);
      else next.add(viewerId);
      return next;
    });
  }, []);

  const togglePaused = () => {
    if (pausedRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = [];
      pausedRef.current = false;
      setPaused(false);
      setPendingCount(0);
      if (pending.length > 0) {
        startTransition(() => {
          setEntries((current) => appendEntries(current, pending));
        });
      }
      return;
    }
    flushAppendBatch();
    pausedRef.current = true;
    setPaused(true);
  };

  const clearLog = async () => {
    setClearing(true);
    try {
      const result = await clearPlatformLog(platform);
      setConfirmClear(false);
      if (!result.cleared) {
        toast.info("暂无可清空的日志文件");
        return;
      }
      pendingRef.current = [];
      cancelAppendBatch();
      setPendingCount(0);
      setEntries([]);
      toast.success("日志已清空，继续接收新日志");
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
    <main
      className={cn(
        "platform-log-viewer @container flex h-full min-w-0 min-h-[400px] flex-col gap-4 px-4 py-5 sm:px-6",
        platform === "youtube-drama" && "youtube-theme youtube-log",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex min-w-28 max-w-52 shrink items-center gap-2"
          title={`${statusMessage}${filePath ? `，${filePath}` : ""}`}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status === "live" && "bg-[var(--log-ready)]",
              status === "connecting" && "bg-[var(--log-info)] motion-safe:animate-pulse",
              status === "waiting" && "bg-[var(--log-warn)]",
              status === "error" && "bg-[var(--log-error)]",
            )}
            role="status"
            aria-label={statusMessage}
          />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {status === "live"
              ? paused
                ? `已暂停${pendingCount ? `，${pendingCount} 条待更新` : ""}`
                : "实时接收中"
              : statusMessage}
          </span>
        </div>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 rounded-md pl-8 pr-8"
            placeholder="搜索账号、任务、范围或错误码"
            aria-label="搜索日志"
          />
          {query && (
            <button
              type="button"
              aria-label="清空日志搜索"
              className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => setQuery("")}
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
        <ListFilterMenu
          label="筛选日志"
          groups={[
            {
              key: "level",
              label: "日志级别",
              value: level,
              defaultValue: "all",
              onChange: (value) => setLevel(value as LevelFilter),
              options: [
                { value: "all", label: "全部级别" },
                ...(["error", "warn", "info", "debug"] as const).map((value) => ({
                  value,
                  label: levelLabels[value],
                })),
              ],
            },
          ]}
        />
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
          <TooltipContent side="bottom" align="end" sideOffset={8}>
            {paused
              ? `继续刷新${pendingCount ? `（有 ${pendingCount} 条新日志）` : ""}`
              : "暂停刷新"}
          </TooltipContent>
        </Tooltip>
        <Button
          variant={follow && !paused ? "secondary" : "outline"}
          size="sm"
          aria-pressed={follow && !paused}
          onClick={() => (follow && !paused ? setFollow(false) : followLatest())}
        >
          {follow && !paused ? "正在跟随" : "跟随最新"}
        </Button>
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
          <TooltipContent side="bottom" align="end" sideOffset={8}>
            打开日志目录
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="清理当前日志"
                disabled={clearing || !filePath}
                onClick={() => setConfirmClear(true)}
              />
            }
          >
            <Trash />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" sideOffset={8}>
            清理当前日志
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={filePath ?? undefined}>
          {currentFileName}
        </span>
        {(query || level !== "all") && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setLevel("all");
            }}
          >
            清除筛选
          </Button>
        )}
      </div>
      <section
        className="relative min-h-0 flex-1 overflow-hidden"
        aria-label="日志内容"
        onWheelCapture={(event) => {
          if (event.deltaY < 0) setFollow(false);
        }}
        onTouchMoveCapture={() => setFollow(false)}
        onPointerDownCapture={() => {
          pointerScrollingRef.current = true;
        }}
        onPointerUpCapture={() => {
          pointerScrollingRef.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) setFollow(false);
        }}
      >
        {filteredEntries.length > 0 ? (
          <Virtuoso
            ref={virtuosoRef}
            className="scroll-fade-y"
            data={filteredEntries}
            computeItemKey={(_index, entry) => entry.viewerId}
            followOutput={() => (follow && !paused ? "auto" : false)}
            totalListHeightChanged={() => {
              if (follow && !paused)
                requestAnimationFrame(() =>
                  virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" }),
                );
            }}
            atBottomThreshold={24}
            atBottomStateChange={(atBottom) => {
              if (!atBottom && pointerScrollingRef.current) setFollow(false);
            }}
            itemContent={(_index, entry) => (
              <LogRow
                entry={entry}
                expanded={expanded.has(entry.viewerId)}
                onToggle={toggleExpanded}
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
                ? "请调整搜索词或清除筛选"
                : status === "waiting"
                  ? "平台开始运行后，新日志会自动出现在这里"
                  : "正在读取最近日志并连接实时日志流"}
            </p>
          </div>
        )}
        {!follow && filteredEntries.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              size="sm"
              variant="secondary"
              className="pointer-events-auto gap-2 shadow-sm"
              onClick={followLatest}
            >
              <ArrowDownIcon aria-hidden="true" />
              {unread ? `${unread} 条新日志，回到最新` : "回到最新"}
            </Button>
          </div>
        )}
      </section>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent className={platform === "youtube-drama" ? "youtube-theme" : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>清空当前日志文件？</AlertDialogTitle>
            <AlertDialogDescription>
              文件内容会被永久清空，但实时监听不会停止，后续产生的新日志仍会继续显示。其他平台和历史日期的日志不会受到影响
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
