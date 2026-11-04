import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkspaceActions, useWorkspacePageActive } from "@/components/workspace-toolbar";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { tiktokNetdiskService } from "@/platforms/tiktok-drama/netdisk-service";
import type { NetdiskDramaList } from "@/platforms/tiktok-drama/netdisk-types";

const labels = { pending: "待转存", running: "转存中", succeeded: "已完成", failed: "失败" };
function ImportDateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const date = value ? new Date(value + "T00:00:00") : undefined;
  return (
    <div className="grid gap-1 text-xs">
      <span>{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button variant="outline" className="min-w-36 justify-start" aria-label={label} />
          }
        >
          {value || "选择日期"}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            locale={zhCN}
            selected={date}
            defaultMonth={date}
            onSelect={(day) => {
              onChange(day ? format(day, "yyyy-MM-dd") : "");
              setOpen(false);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            清除日期
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
export function TiktokNetdiskTransferPage() {
  const active = useWorkspacePageActive();
  const [data, setData] = useState<NetdiskDramaList>({ records: [], total: 0, running: false });
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    try {
      const next = await tiktokNetdiskService.list({
        search: search || undefined,
        from: from || undefined, to: from || undefined,
        status: status || undefined,
        page,
      });
      setData(next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [search, from, status, page]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, active]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <WorkspaceActions label="转存网盘操作">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await tiktokNetdiskService.import();
                if (result) {
                  toast.success(`已导入 ${result.count} 条剧目`);
                  setImportNotes(result.errors);
                  setPage(1);
                }
              })
            }
          >
            导入
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="按导入日期导出，包含所有转存状态"
            onClick={() =>
              void action(async () => {
                const result = await tiktokNetdiskService.export({ from: from || undefined, to: from || undefined });
                if (result) toast.success(`已导出 ${result.count} 条剧目（含失败记录）`);
              })
            }
          >
            导出
          </Button>
          <Button
            size="sm"
            disabled={busy || data.running || !data.total}
            onClick={() =>
              void action(async () => {
                const result = await tiktokNetdiskService.start({
                  search: search || undefined,
                  from: from || undefined, to: from || undefined,
                  status: status || undefined,
                });
                toast.success(`已加入转存队列：${result.accepted} 条`);
              })
            }
          >
            开始转存
          </Button>
          {data.running && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await tiktokNetdiskService.stop();
                  toast.info("将在当前剧目完成后停止");
                })
              }
            >
              停止队列
            </Button>
          )}
        </WorkspaceActions>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          剧名
          <Input
            className="w-48"
            placeholder="搜索剧名"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <ImportDateFilter
          label="导入日期"
          value={from}
          onChange={(value) => {
            setFrom(value);
            setPage(1);
          }}
        />
        <div className="grid gap-1 text-xs">
          <span>转存状态</span>
          <Select
            value={status || "all"}
            onValueChange={(value) => {
              setStatus(value === "all" ? "" : value || "");
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="转存状态" className="min-w-28">
              <SelectValue>
                {status ? labels[status as keyof typeof labels] : "全部状态"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(labels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setSearch("");
            setFrom("");
            setStatus("");
            setPage(1);
          }}
        >
          重置
        </Button>
        <span className="pb-2 text-xs text-muted-foreground" role="status">
          共 {data.total} 条{data.running ? " · 正在转存" : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {importNotes.length > 0 && (
        <details className="text-sm">
          <summary>导入时跳过 {importNotes.length} 行，查看原因</summary>
          <ul className="mt-2 max-h-32 overflow-auto">
            {importNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>剧名</TableHead>
              <TableHead>集数</TableHead>
              <TableHead>全集链接</TableHead>
              <TableHead>导入时间</TableHead>
              <TableHead>进度</TableHead><TableHead>状态</TableHead><TableHead>失败原因</TableHead>
              <TableHead className="w-28">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  正在读取剧单…
                </TableCell>
              </TableRow>
            )}
            {!loading && !data.records.length && (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                  {search || from || status
                    ? "没有符合筛选条件的剧目"
                    : "导入 Excel 剧单后，点击“开始转存”批量处理剧目。请先在百度网盘中登录并开启自动化连接。"}
                </TableCell>
              </TableRow>
            )}
            {data.records.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="min-w-52 max-w-80 whitespace-normal font-medium">
                  {row.title}
                </TableCell>
                <TableCell>{row.episodeCount}</TableCell>
                <TableCell>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(row.shareText).then(
                        () => toast.success("全集链接已复制"),
                        () => toast.error("复制失败"),
                      );
                    }}
                  >
                    复制链接
                  </Button>
                </TableCell>
                <TableCell className="text-xs">
                  {new Date(row.importedAt).toLocaleString()}
                </TableCell>
                <TableCell className="min-w-32">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs"><span>{row.progress} / {row.episodeCount} 集</span><span>{Math.floor(row.progress / row.episodeCount * 100)}%</span></div>
            <div role="progressbar" aria-label={`${row.title}转存进度`} aria-valuemin={0} aria-valuemax={row.episodeCount} aria-valuenow={row.progress} className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, row.progress / row.episodeCount * 100)}%` }} />
            </div>
            {row.status === 'running' && <p className="mt-1 text-xs text-muted-foreground">{row.progressStage || '等待网盘'}</p>}
          </TableCell>
                <TableCell>
                  <Badge variant={row.status === "failed" ? "destructive" : "outline"}>{labels[row.status]}</Badge>
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal break-words text-xs text-destructive">{row.error || "—"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {row.status === "failed" && (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || data.running}
                        onClick={() =>
                          void action(async () => {
                            await tiktokNetdiskService.retry(row.id);
                            toast.success("已开始重试");
                          })
                        }
                      >
                        重试
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || data.running}
                      aria-label={`删除${row.title}`}
                      title="删除列表记录"
                      onClick={() =>
                        void action(async () => {
                          await tiktokNetdiskService.delete(row.id);
                          toast.success("记录已删除");
                          if (data.records.length === 1 && page > 1) setPage(page - 1);
                        })
                      }
                    >
                      删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          第 {page} / {Math.max(1, Math.ceil(data.total / 50))} 页 · 每页 50 条
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage(page - 1);
            }}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page * 50 >= data.total}
            onClick={() => {
              setPage(page + 1);
            }}
          >
            下一页
          </Button>
        </div>
      </div>
    </section>
  );
}
