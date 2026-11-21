import type { YoutubeTask } from "@/platforms/youtube-drama/service";
import { youtubeStageLabels } from "./task-progress";

export function YoutubeEpisodeProgress({ task }: { task: YoutubeTask }) {
  if (task.payload.mode !== "episodes") return null;
  const episodes = task.result?.episodes ?? [];
  return (
    <section aria-label="逐集进度" className="shrink-0 space-y-3">
      <h3 className="text-sm font-medium">逐集进度</h3>
      {!episodes.length ? (
        <p className="text-xs text-muted-foreground">素材下载完成后显示每集处理和上传进度。</p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">每集标题、当前阶段、阶段进度和上传结果</caption>
            <thead className="sticky top-0 bg-background">
              <tr className="border-b">
                <th scope="col" className="px-3 py-2 font-medium">视频标题</th>
                <th scope="col" className="px-3 py-2 font-medium">状态</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">阶段进度</th>
              </tr>
            </thead>
            <tbody>
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
                  <tr key={episode.index} className="border-b last:border-0">
                    <td className="max-w-56 px-3 py-2 break-words" title={episode.source}>
                      {episode.videoUrl && /^https:\/\/youtu\.be\/[A-Za-z0-9_-]+$/.test(episode.videoUrl) ? (
                        <a href={episode.videoUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {episode.title}
                        </a>
                      ) : episode.title || `第${episode.index}集`}
                    </td>
                    <td className={`px-3 py-2 ${episode.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {done ? "100%" : typeof episode.percent === "number" ? `${Number(episode.percent.toFixed(1))}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
