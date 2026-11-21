import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption } from "@/components/ui/table";
import type { YoutubeTask } from "@/platforms/youtube-drama/service";
import { youtubeStageLabels } from "./task-progress";

export function YoutubeEpisodeProgress({ task }: { task: YoutubeTask }) {
  if (task.payload.mode !== "episodes") return null;
  const episodes = task.result?.episodes ?? [];
  return (
    <section aria-label="逐集进度" className="shrink-0 space-y-3">
      <h3 className="text-sm font-medium">逐集进度</h3>
      {!episodes.length ? (
        <EmptyStateCard title="暂无逐集进度" description="素材下载完成后显示每集处理和上传进度" />
      ) : (
        <Table containerClassName="max-h-80 overflow-auto">
          <TableCaption className="sr-only">每集标题、当前阶段、阶段进度和上传结果</TableCaption>
          <TableHeader className="sticky top-0 z-10">
            <TableRow>
              <TableHead scope="col">视频标题</TableHead>
              <TableHead scope="col">状态</TableHead>
              <TableHead scope="col" className="text-right">阶段进度</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {episodes.map((episode) => {
              const done = ["completed", "skipped"].includes(episode.status);
              const current = episode.index === task.progress?.episodeIndex;
              const status = done
                ? task.payload.noUpload ? "已处理" : episode.status === "skipped" ? "已上传，已跳过" : "已上传"
                : episode.status === "queued" ? "等待处理"
                : current && task.status === "paused" ? "已暂停"
                : current && task.status === "cancelled" ? "已取消"
                : episode.status === "failed" ? "失败"
                : youtubeStageLabels[episode.stage ?? ""] ?? "处理中";
              return (
                <TableRow key={episode.index}>
                  <TableCell className="max-w-56 whitespace-normal break-words">
                    <span title={episode.source}>
                      {episode.videoUrl && /^https:\/\/youtu\.be\/[A-Za-z0-9_-]+$/.test(episode.videoUrl) ? (
                        <a href={episode.videoUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {episode.title}
                        </a>
                      ) : episode.title || `第${episode.index}集`}
                    </span>
                  </TableCell>
                  <TableCell className={episode.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{status}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {done ? "100%" : typeof episode.percent === "number" ? `${Number(episode.percent.toFixed(1))}%` : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
