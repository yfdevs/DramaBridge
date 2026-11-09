import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, List } from "@mynaui/icons-react";
import { youtubeService, type YoutubeTask } from "@/platforms/youtube-drama/service";
import { YoutubeFeedback, YoutubeServiceActions, YoutubeEnvironmentWarning } from "./shared";
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

export function YoutubeWorkspacePage() {
  const model = useYoutubeRuntime();
  const { status, tasks, paused, locked, run } = model;
  const [selected, setSelected] = useState<YoutubeTask | null>(null);
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <YoutubeServiceActions model={model} title="YouTube 工作台">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          render={<Link to="/youtube-drama/create" />}
        >
          <Plus className="size-3.5" />
          添加任务
        </Button>
      </YoutubeServiceActions>
      <div className="flex w-full max-w-5xl flex-col gap-4 p-5">
        <YoutubeFeedback model={model} />
        <YoutubeEnvironmentWarning model={model} />
        <div
          aria-label="任务统计"
          className="grid grid-cols-2 gap-3 rounded-lg border px-4 py-3 sm:grid-cols-4"
        >
          {[
            ["全部任务", tasks.length],
            [
              "处理中",
              tasks.filter((t) =>
                ["downloading", "processing", "uploading", "waiting"].includes(t.status),
              ).length,
            ],
            ["已完成", tasks.filter((t) => t.status === "completed").length],
            ["失败", tasks.filter((t) => t.status === "failed").length],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-2 sm:justify-start sm:gap-3"
            >
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        <section className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">任务队列</h2>
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
          {!tasks.length && (
            <p className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-xs text-muted-foreground">
              <List className="size-5 text-muted-foreground/60" />
              {status.running ? "还没有 YouTube 任务" : "启动服务后查看任务"}
              <span className="text-[11px]">添加任务后，在这里查看处理进度。</span>
            </p>
          )}
          <div className="grid gap-3">
            {tasks.map((task) => (
              <div key={task.id} className="rounded-lg border p-3">
                <div className="flex justify-between gap-2">
                  <button
                    className="text-left text-sm font-medium hover:underline"
                    onClick={() =>
                      void run(async () =>
                        setSelected(
                          await youtubeService.request<YoutubeTask>(`/api/tasks/${task.id}`),
                        ),
                      )
                    }
                  >
                    {task.payload.resourceName}
                  </button>
                  <Badge
                    variant={task.status === "failed" ? "destructive" : "secondary"}
                    className="shrink-0 text-[11px]"
                  >
                    {labels[task.status] ?? task.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {
                    (
                      { merge: "合并分离", episodes: "逐集分离", mute: "合并静音" } as Record<
                        string,
                        string
                      >
                    )[task.payload.mode ?? "merge"]
                  }
                  {task.payload.mode === "mute" && task.payload.compress ? " · 高画质压缩" : ""}
                </p>
                {task.progress && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {({ muting: "移除音轨", compressing: "压缩视频" } as Record<string, string>)[
                      task.progress.stage ?? ""
                    ] ?? task.progress.stage}{" "}
                    {typeof task.progress.percent === "number"
                      ? `${task.progress.percent.toFixed(1)}%`
                      : ""}{" "}
                    {task.progress.speedText}
                  </p>
                )}
                {task.error && (
                  <p className="mt-2 break-words text-xs text-destructive">{task.error}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {(task.status === "paused"
                    ? ["resume"]
                    : ["failed", "cancelled"].includes(task.status)
                      ? ["retry"]
                      : ["queued", "downloading", "processing", "uploading", "waiting"].includes(
                            task.status,
                          )
                        ? ["pause", "cancel"]
                        : []
                  ).map((action) => (
                    <Button
                      key={action}
                      size="sm"
                      variant="outline"
                      disabled={locked || !status.running}
                      onClick={() =>
                        void run(() =>
                          youtubeService.request(`/api/tasks/${task.id}/${action}`, {}),
                        )
                      }
                    >
                      {{ resume: "恢复", retry: "重试", pause: "暂停", cancel: "取消" }[action]}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
        {selected && (
          <section className="rounded-lg border p-4">
            <div className="mb-3 flex justify-between">
              <h2 className="text-sm font-semibold">{selected.payload.resourceName} · 执行日志</h2>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                关闭
              </Button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
              {selected.logs ||
                selected.error ||
                JSON.stringify(selected.result, null, 2) ||
                "暂无日志"}
            </pre>
          </section>
        )}
      </div>
    </main>
  );
}
