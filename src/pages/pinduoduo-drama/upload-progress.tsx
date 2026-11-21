import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import type { PinduoduoDramaServiceStatus } from "@/platforms/pinduoduo-drama/service";

const phases = { downloading: "下载素材", uploading: "上传视频", binding: "关联短剧", publishing: "确认发布" };

export function PinduoduoUploadProgressCard({ status }: { status: PinduoduoDramaServiceStatus }) {
  const active = (status.instances ?? []).filter(instance => instance.launched && instance.uploadProgress);
  return (
    <section aria-label="当前上传进度" className="rounded-lg border px-5 py-4">
      <h2 className="text-sm font-medium">当前上传进度</h2>
      {!active.length ? (
        <EmptyStateCard
          className="mt-3 border-0"
          title={status.running ? "等待上传任务" : "暂无上传任务"}
          description={status.running ? undefined : "勾选账号并启动后查看进度"}
        />
      ) : (
        <div className="mt-4 divide-y">{active.map(instance => {
          const progress = instance.uploadProgress!;
          const percentage = progress.total > 0 ? Math.min(100, Math.floor(progress.uploaded / progress.total * 100)) : 0;
          return (
            <div key={instance.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-xs text-muted-foreground">{instance.name}</p>
                  <h3 className="break-words text-base font-medium">{progress.title}</h3>
                </div>
                <Badge variant="secondary">{phases[progress.phase]}</Badge>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm"><span className="text-xl font-semibold tabular-nums">{progress.uploaded}</span><span className="text-muted-foreground"> / {progress.total || "?"} 集已上传</span></p>
                {progress.phase !== "downloading" && <span className="text-sm font-medium tabular-nums">{percentage}%</span>}
              </div>
              <Progress aria-label={`${progress.title}上传进度`} value={progress.phase === "downloading" || !progress.total ? null : percentage} />
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{progress.phase === "downloading" ? "正在准备全集视频和封面" : progress.phase === "binding" ? "视频已上传，正在关联短剧" : progress.phase === "publishing" ? "等待平台确认发布结果" : "上传完成后自动发布"}</span>
                <span className="tabular-nums">{progress.batch ? `第 ${progress.batch}/${progress.batches} 批 · ` : ""}已发布 {progress.published} 集</span>
              </div>
            </div>
          );
        })}</div>
      )}
    </section>
  );
}
