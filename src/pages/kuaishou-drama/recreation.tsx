import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { kuaishouRecreationService as service } from "@/platforms/kuaishou-drama/recreation-service";
import type {
  RecreationTask,
  RecreationWorkspace,
} from "@/platforms/kuaishou-drama/recreation-types";

const labels: Record<RecreationTask["state"], string> = {
  queued: "待处理",
  checking: "检查本地",
  downloading: "下载中",
  processing: "整理中",
  uploading: "上传分享中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
const active = (task: RecreationTask) =>
  ["checking", "downloading", "processing", "uploading"].includes(task.state);
function shareText(task: RecreationTask) {
  return task.results
    .filter((result) => result.shareUrl)
    .map(
      (result) => `${result.title}-60%\n链接：${result.shareUrl}\n提取码：${result.extractionCode}`,
    )
    .join("\n\n");
}

export function KuaishouRecreationPage() {
  const [workspace, setWorkspace] = useState<RecreationWorkspace>({ running: false, tasks: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query);
  const pendingRefresh = useRef<Promise<void> | undefined>(undefined);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async () => {
    if (pendingRefresh.current) {
      refreshAgain.current = true;
      return pendingRefresh.current;
    }
    pendingRefresh.current = (async () => {
      do {
        refreshAgain.current = false;
        try {
          setWorkspace(await service.workspace());
          setError("");
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        } finally { setLoading(false); }
      } while (refreshAgain.current);
    })().finally(() => { pendingRefresh.current = undefined; });
    return pendingRefresh.current;
  }, []);
  useEffect(() => {
    const unsubscribe = service.onChanged(() => void refresh());
    void refresh();
    return unsubscribe;
  }, [refresh]);
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("分享链接已复制");
    } catch {
      toast.error("复制失败，请选择表格中的链接手动复制");
    }
  };
  const tasks = useMemo(() => workspace.tasks.filter(
    (task) =>
      `${task.originalTitle} ${task.versions.join(" ")}`
        .toLowerCase()
        .includes(deferredQuery.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active"
          ? active(task)
          : filter === "failed"
            ? ["failed", "interrupted"].includes(task.state)
            : task.state === filter)),
  ), [workspace.tasks, deferredQuery, filter]);
  const pages = Math.max(1, Math.ceil(tasks.length / 50));
  const currentPage = Math.min(page, pages);
  const visibleTasks = tasks.slice((currentPage - 1) * 50, currentPage * 50);
  const hasActive = workspace.tasks.some(active);
  return (
    <main aria-label="二创" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col">
        <header className="shrink-0 space-y-3 border-b px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (await service.template()) toast.success("Excel 模板已保存");
                  })
                }
              >
                下载 Excel 模板
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await service.importExcel();
                    if (result.count) toast.success(`已导入 ${result.count} 个任务`);
                  })
                }
              >
                导入 Excel
              </Button>
              <Button
                size="sm"
                disabled={
                  busy ||
                  loading ||
                  workspace.running ||
                  hasActive ||
                  !workspace.tasks.some((task) => task.state === "queued")
                }
                onClick={() => void action(service.start)}
              >
                开始处理
              </Button>
              {workspace.running && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void action(service.pause)}
                >
                  本条完成后暂停
                </Button>
              )}
              {hasActive && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void action(service.cancel)}
                >
                  停止当前任务
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1" aria-label="任务状态筛选">
              {[
                ["all", "全部"],
                ["queued", "待处理"],
                ["active", "进行中"],
                ["completed", "已完成"],
                ["failed", "失败 / 中断"],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={filter === value ? "secondary" : "ghost"}
                  aria-pressed={filter === value}
                  onClick={() => { setFilter(value); setPage(1); }}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex w-full items-center gap-1 sm:w-auto">
              <Input
                aria-label="搜索原剧名或版本名"
                placeholder="搜索原剧名或版本名"
                className="h-8 flex-1 sm:w-52"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              />
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                刷新
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
              {error}
            </p>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
          <Table className="min-w-[860px] table-fixed text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">原剧名</TableHead>
                <TableHead className="w-28">集数</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead>进度</TableHead>
                <TableHead className="w-24">版本</TableHead>
                <TableHead className="w-48 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    正在加载任务…
                  </TableCell>
                </TableRow>
              ) : !tasks.length ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-32 whitespace-normal text-center text-muted-foreground"
                  >
                    {workspace.tasks.length
                      ? "没有符合筛选条件的任务"
                      : "先下载 Excel 模板，填写后导入。一行一个任务，导入后点击“开始处理”。"}
                  </TableCell>
                </TableRow>
              ) : (
                visibleTasks.map((task) => {
                  const completedVersions = task.results.filter((result) => result.shareUrl).length;
                  return (
                    <TableRow key={task.id} className="h-11">
                      <TableCell className="py-1.5 font-medium">
                        <div className="truncate" title={task.originalTitle}>
                          {task.originalTitle}
                        </div>
                      </TableCell>
                      <TableCell className="py-1.5 tabular-nums text-muted-foreground">
                        {task.episodeCount} 集 → {task.downloadCount} 集
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Badge variant={task.state === "failed" ? "destructive" : "secondary"}>
                          {labels[task.state]}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-1.5 text-muted-foreground">
                        <Popover>
                          <PopoverTrigger
                            render={
                              <button
                                type="button"
                                className="block w-full truncate rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                title={task.message || "等待开始"}
                                aria-label={`查看${task.originalTitle}的任务进度`}
                              />
                            }
                          >
                            {task.message || "等待开始"}
                          </PopoverTrigger>
                          <PopoverContent
                            align="start"
                            className="max-h-72 w-80 max-w-[calc(100vw-2rem)] overflow-auto"
                          >
                            <PopoverTitle>任务进度</PopoverTitle>
                            <p className="whitespace-pre-wrap break-words text-xs leading-5">
                              {task.message || "等待开始"}
                            </p>
                          </PopoverContent>
                        </Popover>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Popover>
                          <PopoverTrigger
                            render={
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs tabular-nums"
                                aria-label={`查看${task.originalTitle}的版本与分享链接`}
                              />
                            }
                          >
                            {completedVersions} / {task.results.length} · 查看
                          </PopoverTrigger>
                          <PopoverContent
                            align="end"
                            className="w-96 max-w-[calc(100vw-2rem)] gap-0 p-0"
                          >
                            <div className="border-b px-3 py-2.5">
                              <PopoverTitle>版本与分享链接</PopoverTitle>
                            </div>
                            <div className="max-h-[min(360px,60vh)] overflow-y-auto divide-y">
                              {task.results.map((result) => (
                                <div key={result.title} className="space-y-1.5 px-3 py-2.5">
                                  <div className="flex items-start justify-between gap-2">
                                    <span className="min-w-0 break-words text-xs font-medium">
                                      {result.title}-60%
                                    </span>
                                    {result.shareUrl && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 shrink-0 px-2 text-xs"
                                        onClick={() =>
                                          void copy(
                                            `${result.title}-60%\n链接：${result.shareUrl}\n提取码：${result.extractionCode}`,
                                          )
                                        }
                                      >
                                        复制链接
                                      </Button>
                                    )}
                                  </div>
                                  {result.shareUrl ? (
                                    <p className="select-text break-all text-xs leading-5 text-muted-foreground">
                                      {result.shareUrl}
                                      <br />
                                      提取码：{result.extractionCode}
                                    </p>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">待生成分享链接</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          {completedVersions > 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => void copy(shareText(task))}
                            >
                              复制全部链接
                            </Button>
                          )}
                          {["failed", "interrupted"].includes(task.state) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={busy}
                              onClick={() => void action(() => service.retry(task.id))}
                            >
                              重试
                            </Button>
                          )}
                          {(task.localPath || !active(task)) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    disabled={busy}
                                    aria-label={`${task.originalTitle}的更多操作`}
                                  />
                                }
                              >
                                更多
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {task.localPath && (
                                  <DropdownMenuItem
                                    onClick={() => void action(() => service.open(task.id))}
                                  >
                                    本地目录
                                  </DropdownMenuItem>
                                )}
                                {!active(task) && (
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `删除“${task.originalTitle}”的任务记录？本地素材与网盘文件会保留。`,
                                        )
                                      )
                                        void action(() => service.delete(task.id));
                                    }}
                                  >
                                    删除记录
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {pages > 1 && (
          <nav aria-label="任务分页" className="flex shrink-0 items-center justify-end gap-3 border-t px-6 py-2 text-xs">
            <Button size="sm" variant="ghost" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button>
            <span>{currentPage} / {pages}</span>
            <Button size="sm" variant="ghost" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</Button>
          </nav>
        )}
      </div>
    </main>
  );
}
