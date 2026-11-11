import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { YoutubeFilterSelect, YoutubeSearchField } from "./filter-controls";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Plus, List } from "@mynaui/icons-react";
import { youtubeService, type YoutubeTask } from "@/platforms/youtube-drama/service";
import { useYoutubeRuntime } from "./use-youtube-runtime";
import { YoutubeFeedback, YoutubeServiceActions, YoutubeEnvironmentWarning } from "./shared";
import { YoutubeListPagination } from "./list-controls";
import { useYoutubePagination } from "./use-youtube-pagination";
import { YoutubeTaskDetails } from "./task-details";

const labels: Record<string, string> = {
  queued: "排队中",
  downloading: "下载中",
  processing: "处理中",
  uploading: "上传中",
  waiting: "等待恢复",
  completed: "已完成",
  paused: "已暂停",
  failed: "失败",
  cancelled: "已取消",
};
const modes: Record<string, string> = { merge: "合并分离", mute: "合并静音" };
const activeStatuses = ["downloading", "processing", "uploading", "waiting"];
const stages: Record<string, string> = {
  muting: "移除音轨",
  compressing: "压缩视频",
  downloading: "下载素材",
  processing: "处理视频",
  uploading: "上传视频",
};
function timeText(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}
function TaskProgress({ task, open }: { task: YoutubeTask; open: () => void }) {
  const percent =
    typeof task.progress?.percent === "number" && Number.isFinite(task.progress.percent)
      ? Math.max(0, Math.min(100, task.progress.percent))
      : null;
  const active = activeStatuses.includes(task.status);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant={task.status === "failed" ? "destructive" : "secondary"}
          className="text-[11px]"
        >
          {labels[task.status] ?? task.status}
        </Badge>
        {percent !== null && active && (
          <span className="tabular-nums text-muted-foreground">{percent.toFixed(1)}%</span>
        )}
      </div>
      {percent !== null && active && (
        <div
          role="progressbar"
          aria-label={`${task.payload.resourceName}处理进度`}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      )}
      {task.progress?.stage && active && (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
          {stages[task.progress.stage] ?? task.progress.stage} {task.progress.speedText}
        </p>
      )}
      {task.error && (
        <button
          className="mt-1.5 block w-full truncate text-left text-[11px] text-destructive hover:underline"
          title={task.error}
          onClick={open}
        >
          {task.error}
        </button>
      )}
    </>
  );
}

export function YoutubeWorkspacePage() {
  const model = useYoutubeRuntime();
  const { status, tasks, accounts, paused, locked, run, loading } = model;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [mode, setMode] = useState("all");
  const [sort, setSort] = useState("newest");
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const filtered = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase();
    return tasks
      .filter(
        (task) =>
          (!query ||
            [task.payload.resourceName, task.payload.title, task.id].some((value) =>
              value?.toLocaleLowerCase().includes(query),
            )) &&
          (!taskStatus ||
            (taskStatus === "active"
              ? activeStatuses.includes(task.status)
              : task.status === taskStatus)) &&
          (mode === "all" || (task.payload.mode ?? "merge") === mode),
      )
      .sort((a, b) => {
        const field = sort === "updated" ? "updated" : "created";
        const difference = (Date.parse(b[field]) || 0) - (Date.parse(a[field]) || 0);
        return (sort === "oldest" ? -difference : difference) || a.id.localeCompare(b.id);
      });
  }, [tasks, keyword, taskStatus, mode, sort]);
  const list = useYoutubePagination(filtered);
  const hasFilters = Boolean(keyword || taskStatus || mode !== "all");
  const reset = () => {
    setKeyword("");
    setTaskStatus("");
    setMode("all");
    list.reset();
  };
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <YoutubeServiceActions model={model} title="YouTube 工作台">
        <Button size="sm" className="h-7 text-xs" render={<Link to="/youtube-drama/create" />}>
          <Plus className="size-3.5" />
          添加任务
        </Button>
      </YoutubeServiceActions>
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">任务列表</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              查看素材处理与上传进度，管理任务队列。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={locked || loading}
              onClick={() => void run(model.refresh)}
            >
              刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !status.running}
              onClick={() =>
                void run(() => youtubeService.request("/api/settings", { paused: !paused }))
              }
            >
              {paused ? "恢复队列" : "暂停队列"}
            </Button>
          </div>
        </div>
        <YoutubeFeedback model={model} />
        <YoutubeEnvironmentWarning model={model} />
        {paused && status.running && (
          <p
            role="status"
            className="rounded-lg border border-amber-300/60 bg-amber-50/50 px-4 py-3 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200"
          >
            队列已暂停，新任务将等待恢复后执行。
          </p>
        )}
        <section aria-label="YouTube 任务列表" className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b pb-4">
            <YoutubeSearchField
              label="搜索任务"
              placeholder="搜索剧名、标题或任务编号"
              value={keyword}
              onChange={(value) => {
                setKeyword(value);
                list.reset();
              }}
            />
            <YoutubeFilterSelect
              label="任务状态"
              caption="状态"
              value={taskStatus}
              onChange={(value) => {
                setTaskStatus(value);
                list.reset();
              }}
              options={[
                { value: "", label: "全部" },
                { value: "active", label: "进行中" },
                { value: "completed", label: "已完成" },
                { value: "failed", label: "失败" },
              ]}
            />
            <YoutubeFilterSelect
              label="处理方式"
              caption="处理方式"
              value={mode}
              onChange={(value) => {
                setMode(value);
                list.reset();
              }}
              options={[
                { value: "all", label: "" },
                ...Object.entries(modes).map(([value, label]) => ({ value, label })),
              ]}
            />
            <YoutubeFilterSelect
              label="任务排序"
              value={sort}
              onChange={(value) => {
                setSort(value);
                list.reset();
              }}
              options={[
                { value: "newest", label: "最新创建" },
                { value: "oldest", label: "最早创建" },
                { value: "updated", label: "最近更新" },
              ]}
            />
            {hasFilters && (
              <Button size="sm" variant="ghost" onClick={reset}>
                清除筛选
              </Button>
            )}
          </div>
          <Table className="min-w-[900px] text-xs" aria-busy={loading}>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="w-[28%] pl-4">任务 / 剧名</TableHead>
                <TableHead>处理方式</TableHead>
                <TableHead>上传账号</TableHead>
                <TableHead className="w-[20%]">状态与进度</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading
                ? Array.from({ length: 5 }, (_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 6 }, (_, cell) => (
                        <TableCell key={cell} className="p-4">
                          <div className="h-4 rounded bg-muted motion-safe:animate-pulse" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : list.items.map((task) => {
                    const actions =
                      task.status === "paused"
                        ? ["resume"]
                        : ["failed", "cancelled"].includes(task.status)
                          ? ["retry"]
                          : ["queued", ...activeStatuses].includes(task.status)
                            ? ["pause", "cancel"]
                            : [];
                    return (
                      <TableRow key={task.id}>
                        <TableCell className="max-w-0 whitespace-normal py-4 pl-4">
                          <button
                            className="max-w-full truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
                            title={task.payload.resourceName}
                            onClick={() => setSelectedId(task.id)}
                          >
                            {task.payload.resourceName}
                          </button>
                          <p
                            className="mt-1 truncate text-[11px] text-muted-foreground"
                            title={task.payload.title || task.id}
                          >
                            {task.payload.title && task.payload.title !== task.payload.resourceName
                              ? task.payload.title
                              : `编号 ${task.id}`}
                          </p>
                        </TableCell>
                        <TableCell>
                          {modes[task.payload.mode ?? "merge"] ??
                            (task.payload.mode === "episodes"
                              ? "逐集分离（已停用）"
                              : task.payload.mode)}
                          {task.payload.mode === "mute" && task.payload.compress && (
                            <p className="mt-1 text-[11px] text-muted-foreground">高画质压缩</p>
                          )}
                        </TableCell>
                        <TableCell
                          className="max-w-36 truncate"
                          title={accountNames.get(task.payload.accountId ?? "default")}
                        >
                          {accountNames.get(task.payload.accountId ?? "default") ?? "未指定账号"}
                        </TableCell>
                        <TableCell className="max-w-64 whitespace-normal py-4">
                          <TaskProgress task={task} open={() => setSelectedId(task.id)} />
                        </TableCell>
                        <TableCell
                          className="tabular-nums text-muted-foreground"
                          title={task.created}
                        >
                          {timeText(task.created)}
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setSelectedId(task.id)}
                            >
                              详情
                            </Button>
                            {actions.map((action) => (
                              <Button
                                key={action}
                                size="sm"
                                variant="ghost"
                                disabled={locked || !status.running}
                                onClick={() =>
                                  void run(() =>
                                    youtubeService.request(
                                      `/api/tasks/${encodeURIComponent(task.id)}/${action}`,
                                      {},
                                    ),
                                  )
                                }
                              >
                                {
                                  { resume: "恢复", retry: "重试", pause: "暂停", cancel: "取消" }[
                                    action
                                  ]
                                }
                              </Button>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              {!loading && !list.total && (
                <TableRow>
                  <TableCell colSpan={6} className="py-16 text-center">
                    <List className="mx-auto mb-3 size-6 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      {hasFilters
                        ? "没有符合条件的任务"
                        : status.running
                          ? "还没有任务"
                          : "服务尚未启动"}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {hasFilters
                        ? "调整搜索词或筛选条件后重试。"
                        : status.running
                          ? "添加任务后，可在这里跟踪处理与上传进度。"
                          : "启动 YouTube 服务后查看任务队列。"}
                    </p>
                    {hasFilters && (
                      <Button className="mt-3" size="sm" variant="outline" onClick={reset}>
                        清除筛选
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <YoutubeListPagination list={list} />
        </section>
        <p className="text-[11px] text-muted-foreground">
          {status.running ? "自动更新" : "服务已停止"} · 展示最近 500
          条任务，筛选与统计基于这些任务。
        </p>
      </div>
      <YoutubeTaskDetails
        task={selected}
        running={status.running}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}
