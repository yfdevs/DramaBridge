import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { ManagementListSkeleton, ManagementTableSkeleton } from "@/pages/shared/management-skeleton";
import { OverflowText } from "@/components/ui/overflow-text";
import { YoutubeTaskProgress as TaskProgress, youtubeDuration } from "./task-progress";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { Fragment, useMemo, useState } from "react";
import { YoutubeAddTaskButton } from "./add-task-button";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { FilterSearchField, FilterToolbar } from "@/components/filter-controls";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { PauseIcon, PlayIcon, RefreshIcon as RefreshCwIcon } from "@/components/ui/solar-icons";
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
import { YoutubeWebTaskProgress, youtubeWebCreatedTime } from "./web-task-progress";
import { YoutubeWebTaskFailure } from "./web-task-failure";

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
    <div className="flex flex-wrap items-center justify-start gap-1">
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
      <AlertDialog>
        <AlertDialogTrigger render={<Button size="sm" variant="ghost" className="text-destructive" disabled={disabled} />}>
          删除
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除任务？</AlertDialogTitle>
            <AlertDialogDescription>
              将停止“{task.payload.resourceName}”并删除任务及其本地下载资源、处理缓存。其他任务引用的资源会保留，不会删除已上传的 YouTube 视频
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void run(() => youtubeService.request(`/api/tasks/${encodeURIComponent(task.id)}/delete`, {}))}>
              删除任务和资源
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <EmptyStateCard
      title={filtered ? "没有符合条件的任务" : "还没有任务"}
      description={filtered
        ? "调整搜索词或筛选条件后重试"
        : running
          ? "添加任务后，可在这里跟踪处理与上传进度"
          : isYoutubeWeb
            ? "请在桌面端添加任务"
            : "添加任务后，可在这里查看处理记录"}
      action={filtered ? (
        <Button size="sm" variant="outline" onClick={reset}>清除筛选</Button>
      ) : running ? <YoutubeAddTaskButton /> : null}
    />
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
  const accountColumn = isYoutubeWeb ? "" : "hidden xl:table-cell";
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
          {isYoutubeWeb && (
            <h1 className="mb-3 flex items-center gap-2 text-sm font-medium">
              任务列表
              <span className="text-xs font-normal tabular-nums text-muted-foreground">{tasks.length}</span>
            </h1>
          )}
          <FilterToolbar label="任务筛选" className="pb-3">
            <FilterSearchField
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
                  ].map((option) => isYoutubeWeb ? {
                    ...option,
                    count: tasks.filter((task) => !option.value || (
                      option.value === "active" ? activeStatuses.includes(task.status) : task.status === option.value
                    )).length,
                  } : option),
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
                      .filter(([value]) => isYoutubeWeb || value !== "episodes")
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
                variant="state"
                data-active={paused ? "" : undefined}
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
          </FilterToolbar>
          {isYoutubeWeb && (
            <div className="lg:hidden" aria-busy={loading} data-skeleton-transition>
              {loading ? (
                <ManagementListSkeleton label="正在读取任务" />
              ) : list.items.length ? (
                list.items.map((task) => (
                  <article
                    key={task.id}
                    aria-label={task.payload.resourceName}
                    className="flex min-w-0 flex-col gap-2 py-3"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <OverflowText as="button"
                          className="block max-w-full truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
                          onClick={() => setSelectedId(task.id)}
                        >
                          {task.payload.resourceName}
                        </OverflowText>
                        <OverflowText as="p" className="mt-1 truncate text-xs text-muted-foreground">
                          {accountNames.get(task.payload.accountId ?? "default") ?? "未指定账号"}
                        </OverflowText>
                        <p className="mt-1 truncate text-xs tabular-nums text-muted-foreground">{modes[task.payload.mode ?? "merge"]} · {youtubeWebCreatedTime(task.created)}</p>
                      </div>
                      <TaskActions
                        task={task}
                        disabled={locked || !status.running}
                        run={run}
                        onDetails={() => setSelectedId(task.id)}
                      />
                    </div>
                    <div className="flex min-w-0 items-start gap-3">
                      <YoutubeTaskStatus status={task.status} reason={task.status === "failed" ? task.progress?.failure?.reason ?? task.error : undefined} />
                      <div className="min-w-0 flex-1">
                        <YoutubeWebTaskProgress task={task} />
                      </div>
                    </div>
                    <YoutubeWebTaskFailure task={task} />
                  </article>
                ))
              ) : (
                <TaskEmptyState filtered={hasFilters} running={status.running} reset={reset} />
              )}
            </div>
          )}
          <Table stickyActions
            containerClassName={isYoutubeWeb ? "hidden lg:block" : undefined}
            className={
              isYoutubeWeb
                ? "min-w-[1024px] table-fixed"
                : "min-w-[620px] table-fixed xl:min-w-[760px]"
            }
            aria-busy={loading}
          >
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">剧名</TableHead>
                <TableHead className={`${accountColumn} w-32`}>上传账号</TableHead>
                <TableHead className="w-18">状态</TableHead>
                {isYoutubeWeb && <TableHead className="w-28">处理方式</TableHead>}
                <TableHead className={isYoutubeWeb ? "w-56" : "w-48"}>进度</TableHead>
                {isYoutubeWeb && <TableHead className="w-28">创建时间</TableHead>}
                <TableHead className="w-18">耗时</TableHead>
                <TableHead className={`${isYoutubeWeb ? "w-36" : "w-40"} pr-3 text-left`}>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody data-skeleton-transition>
              {loading
                ? <ManagementTableSkeleton
                    columns={isYoutubeWeb
                      ? ["w-3/4 max-w-40", "w-20", "h-4 w-12 rounded-full", "w-16", "h-1.5 w-4/5 rounded-full", "w-20", "w-10", "h-5 w-16"]
                      : ["w-3/4 max-w-40", { placeholder: "w-20", cell: accountColumn }, "h-4 w-12 rounded-full", "h-1.5 w-4/5 rounded-full", "w-10", "h-5 w-20"]}
                    rowClassName="h-9"
                  />
                : list.items.map((task) => {
                    const elapsed = youtubeTaskElapsed(task);
                    return (
                      <Fragment key={task.id}>
                      <TableRow data-state={isYoutubeWeb && task.id === selectedId ? "selected" : undefined}>
                        <TableCell className="max-w-0 pl-3">
                          <OverflowText as="button"
                            className={`${isYoutubeWeb ? "w-full" : ""} block max-w-full truncate text-left text-xs font-medium underline-offset-4 hover:underline focus-visible:underline`}
                            title={[task.payload.resourceName, task.payload.title, task.id]
                              .filter(Boolean)
                              .join("\n")}
                            onClick={() => setSelectedId(task.id)}
                          >
                            {task.payload.resourceName}
                          </OverflowText>
                        </TableCell>
                        <TableCell
                          className={`${accountColumn} max-w-36 truncate`}
                          title={accountNames.get(task.payload.accountId ?? "default")}
                        >
                          {accountNames.get(task.payload.accountId ?? "default") ?? "未指定账号"}
                        </TableCell>
                        <TableCell>
                          <YoutubeTaskStatus status={task.status} reason={task.status === "failed" ? task.progress?.failure?.reason ?? task.error : undefined} />
                        </TableCell>
                        {isYoutubeWeb && <TableCell className="text-muted-foreground">{modes[task.payload.mode ?? "merge"] ?? "—"}</TableCell>}
                        <TableCell className="min-w-0">
                          {isYoutubeWeb ? <YoutubeWebTaskProgress task={task} /> : <TaskProgress task={task} compact open={() => setSelectedId(task.id)} />}
                        </TableCell>
                        {isYoutubeWeb && <TableCell className="tabular-nums text-muted-foreground"><time dateTime={task.created} title={new Date(task.created).toLocaleString("zh-CN", { hour12: false })}>{youtubeWebCreatedTime(task.created)}</time></TableCell>}
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
                            showDetails={!isYoutubeWeb}
                          />
                        </TableCell>
                      </TableRow>
                      {isYoutubeWeb && task.status === "failed" && (
                        <TableRow>
                          <TableCell colSpan={8} className="whitespace-normal px-3 !pt-0">
                            <YoutubeWebTaskFailure task={task} />
                          </TableCell>
                        </TableRow>
                      )}
                      </Fragment>
                    );
                  })}
              {!loading && !list.total && (
                <TableRow>
                  <TableCell colSpan={isYoutubeWeb ? 8 : 6} className="p-3">
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
