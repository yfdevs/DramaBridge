import { YoutubeTaskProgress as TaskProgress, youtubeDuration } from "./task-progress";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { useMemo, useState } from "react";
import { YoutubeAddTaskButton } from "./add-task-button";
import { Button } from "@/components/ui/button";
import { YoutubeSearchField } from "./filter-controls";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { List } from "@mynaui/icons-react";
import { PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { youtubeService, isYoutubeWeb, type YoutubeTask } from "@/platforms/youtube-drama/service";
import { useYoutubeRuntime, type YoutubeModel } from "./use-youtube-runtime";
import {
  YoutubeServiceActions,
  YoutubeEnvironmentWarning,
  YoutubePageContent,
} from "./shared";
import { YoutubeListPagination } from "./list-controls";
import { useYoutubePagination } from "./use-youtube-pagination";
import { YoutubeTaskDetails } from "./task-details";
import {
  YoutubeTaskStatus,
  youtubeActiveStatuses as activeStatuses,
  youtubeModeLabels as modes,
} from "./task-status";
import { youtubeTaskElapsed } from "./task-progress-data";

type TaskAction = "resume" | "retry" | "pause" | "cancel";
function taskActions(task: YoutubeTask): TaskAction[] {
  if (task.status === "paused") return ["resume"];
  if (["failed", "cancelled"].includes(task.status)) return ["retry"];
  if (task.status === "queued") return ["pause", "cancel"];
  if (activeStatuses.includes(task.status)) return ["pause"];
  return [];
}

function TaskActions({
  task,
  disabled,
  onDetails,
  run,
  showDetails = true,
}: {
  task: YoutubeTask;
  disabled: boolean;
  onDetails: () => void;
  run: YoutubeModel["run"];
  showDetails?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      {showDetails && (
        <Button size="sm" variant="ghost" onClick={onDetails}>
          详情
        </Button>
      )}
      {taskActions(task).map((action) => (
        <Button
          key={action}
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            void run(() =>
              youtubeService.request(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {}),
            )
          }
        >
          {{ resume: "继续", retry: "重试", pause: "暂停", cancel: "取消" }[action]}
        </Button>
      ))}
    </div>
  );
}

function TaskEmptyState({
  filtered,
  running,
  reset,
}: {
  filtered: boolean;
  running: boolean;
  reset: () => void;
}) {
  return (
    <div className="py-12 text-center" role="status">
      <List aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-sm font-medium">
        {filtered ? "没有符合条件的任务" : "还没有任务"}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        {filtered
          ? "调整搜索词或筛选条件后重试"
          : running
            ? "添加任务后，可在这里跟踪处理与上传进度"
            : isYoutubeWeb
              ? "请在桌面端添加任务"
              : "添加任务后，可在这里查看处理记录"}
      </p>
      {filtered ? (
        <Button className="mt-3" size="sm" variant="outline" onClick={reset}>
          清除筛选
        </Button>
      ) : running ? (
        <YoutubeAddTaskButton className="mt-3" />
      ) : null}
    </div>
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
  const accountColumn = isYoutubeWeb ? "hidden @min-[1100px]:table-cell" : "hidden xl:table-cell";
  return (
    <main
      aria-label="YouTube 任务列表"
      className="youtube-theme flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <YoutubeServiceActions model={model} title="YouTube 工作台">
        {!isYoutubeWeb && <YoutubeAddTaskButton />}
      </YoutubeServiceActions>
      <YoutubePageContent>
        <YoutubeEnvironmentWarning model={model} />
        {paused && status.running && (
          <p
            role="status"
            className="rounded-md bg-[var(--youtube-warning-bg)] px-4 py-3 text-sm text-[var(--youtube-warning-text)]"
          >
            队列已暂停，新任务将等待恢复后执行
          </p>
        )}
        <section aria-label="YouTube 任务列表" className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 pb-4">
            <YoutubeSearchField
              label="搜索任务"
              placeholder="搜索剧名、标题或任务编号"
              value={keyword}
              onChange={(value) => {
                setKeyword(value);
                list.reset();
              }}
            />
            <ListFilterMenu
              label="筛选任务"
              groups={[
                {
                  key: "taskStatus",
                  label: "任务状态",
                  value: taskStatus,
                  defaultValue: "",
                  onChange: (value) => {
                    setTaskStatus(value);
                    list.reset();
                  },
                  options: [
                    { value: "", label: "全部" },
                    { value: "active", label: "进行中" },
                    { value: "queued", label: "排队中" },
                    { value: "paused", label: "已暂停" },
                    { value: "completed", label: "已完成" },
                    { value: "failed", label: "失败" },
                    { value: "cancelled", label: "已取消" },
                  ],
                },
                {
                  key: "mode",
                  label: "处理方式",
                  value: mode,
                  defaultValue: "all",
                  onChange: (value) => {
                    setMode(value);
                    list.reset();
                  },
                  options: [
                    { value: "all", label: "全部方式" },
                    ...Object.entries(modes)
                      .filter(([value]) => value !== "episodes")
                      .map(([value, label]) => ({ value, label })),
                  ],
                },
                {
                  key: "sort",
                  label: "任务排序",
                  value: sort,
                  defaultValue: "newest",
                  onChange: (value) => {
                    setSort(value);
                    list.reset();
                  },
                  options: [
                    { value: "newest", label: "最新创建" },
                    { value: "oldest", label: "最早创建" },
                    { value: "updated", label: "最近更新" },
                  ],
                },
              ]}
            />
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="刷新任务"
                title="刷新任务"
                disabled={locked || loading}
                onClick={() => void run(model.refresh)}
              >
                <RefreshCwIcon aria-hidden="true" />
              </Button>
              <Button
                size="icon-sm"
                variant={paused ? "secondary" : "outline"}
                aria-label={paused ? "恢复队列" : "暂停队列"}
                title={paused ? "恢复队列" : "暂停队列"}
                disabled={locked || !status.running}
                onClick={() =>
                  void run(() => youtubeService.request("/api/settings", { paused: !paused }))
                }
              >
                {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
              </Button>
            </div>
          </div>
          {isYoutubeWeb && (
            <div className="sm:hidden" aria-busy={loading}>
              {loading ? (
                <p role="status" className="py-12 text-center text-sm text-muted-foreground">
                  正在读取任务…
                </p>
              ) : list.items.length ? (
                list.items.map((task) => (
                  <article
                    key={task.id}
                    aria-label={task.payload.resourceName}
                    className="flex min-w-0 flex-col gap-2 py-3"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <button
                          className="block max-w-full truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
                          onClick={() => setSelectedId(task.id)}
                        >
                          {task.payload.resourceName}
                        </button>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {accountNames.get(task.payload.accountId ?? "default") ?? "未指定账号"}
                        </p>
                      </div>
                      <TaskActions
                        task={task}
                        disabled={locked || !status.running}
                        run={run}
                        onDetails={() => setSelectedId(task.id)}
                      />
                    </div>
                    <div className="flex min-w-0 items-start gap-3">
                      <YoutubeTaskStatus status={task.status} />
                      <div className="min-w-0 flex-1">
                        <TaskProgress task={task} compact open={() => setSelectedId(task.id)} />
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <TaskEmptyState filtered={hasFilters} running={status.running} reset={reset} />
              )}
            </div>
          )}
          <Table
            containerClassName={isYoutubeWeb ? "hidden sm:block" : undefined}
            className={
              isYoutubeWeb
                ? "min-w-[480px] table-fixed text-xs"
                : "min-w-[600px] table-fixed text-xs"
            }
            aria-busy={loading}
          >
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="w-[24%] pl-3">剧名</TableHead>
                <TableHead className={accountColumn}>上传账号</TableHead>
                <TableHead className="w-18">状态</TableHead>
                <TableHead className="w-[30%]">进度</TableHead>
                <TableHead className="w-18">耗时</TableHead>
                <TableHead className="w-36 pr-3 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:py-2 [&_tr]:border-0">
              {loading
                ? Array.from({ length: 5 }, (_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 6 }, (_, cell) => (
                        <TableCell key={cell} className={`px-3 ${cell === 1 ? accountColumn : ""}`}>
                          <div className="h-4 rounded bg-muted motion-safe:animate-pulse" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : list.items.map((task) => {
                    const elapsed = youtubeTaskElapsed(task);
                    return (
                      <TableRow key={task.id}>
                        <TableCell className="max-w-0 pl-3">
                          <button
                            className="block max-w-full truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
                            title={[task.payload.resourceName, task.payload.title, task.id]
                              .filter(Boolean)
                              .join("\n")}
                            onClick={() => setSelectedId(task.id)}
                          >
                            {task.payload.resourceName}
                          </button>
                        </TableCell>
                        <TableCell
                          className={`${accountColumn} max-w-36 truncate`}
                          title={accountNames.get(task.payload.accountId ?? "default")}
                        >
                          {accountNames.get(task.payload.accountId ?? "default") ?? "未指定账号"}
                        </TableCell>
                        <TableCell>
                          <YoutubeTaskStatus status={task.status} />
                        </TableCell>
                        <TableCell className="min-w-0">
                          <TaskProgress task={task} compact open={() => setSelectedId(task.id)} />
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {elapsed !== undefined && Number.isFinite(elapsed)
                            ? youtubeDuration(elapsed)
                            : "—"}
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          <TaskActions
                            task={task}
                            disabled={locked || !status.running}
                            onDetails={() => setSelectedId(task.id)}
                            run={run}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
              {!loading && !list.total && (
                <TableRow>
                  <TableCell colSpan={6} className="py-16 text-center">
                    <TaskEmptyState filtered={hasFilters} running={status.running} reset={reset} />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <YoutubeListPagination list={list} />
        </section>
      </YoutubePageContent>
      <YoutubeTaskDetails
        task={selected}
        running={status.running}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}
