import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";
import { getBaiduAutoCleanupStatus, resumeBaiduAutoCleanup, type AutoCleanupStatus } from "@/platforms/baidu-netdisk/service";

export function BaiduAutoCleanupStatus({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<AutoCleanupStatus>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!window.ipcRenderer || !enabled) return;
    let disposed = false, reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try { const next = await getBaiduAutoCleanupStatus(); if (!disposed) { setStatus(next); setError(""); } }
      catch { if (!disposed) setError("清理状态暂时无法读取，稍后重试"); }
      finally { reading = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [enabled]);
  if (!enabled) return null;
  return <div className="space-y-2 text-xs text-muted-foreground" aria-live="polite">
    <p>{status?.total ? `网盘已用 ${(100 * (status.used ?? 0) / status.total).toFixed(1)}% · ` : ""}{error || status?.message || "保存后自动检查网盘容量"}</p>
    {status?.current && <p className="break-all">当前目录：{status.current}</p>}
    {status?.phase === "paused" && status.batch && <p>暂停批次：第 {status.batch.index} 批 · {status.batch.kind === "empty-directory" ? `${status.batch.count} 个空目录` : `${status.batch.count} 个文件，${(status.batch.bytes / 1_000_000_000).toFixed(2)} GB`} · 已确认完成 {status.batch.confirmedBatches} 批</p>}
    {status?.phase === "paused" && <div className="flex flex-wrap items-center gap-3">
      {status.pauseKind !== "identity" && <p>请先核对目录或检查网盘提示，再恢复清理。</p>}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => {
        setPending(true);
        void resumeBaiduAutoCleanup().then(setStatus).catch(error => toast.error("恢复清理失败", { description: String(error) })).finally(() => setPending(false));
      }}>{pending ? "处理中…" : "核对后重试清理"}</Button>
    </div>}
  </div>;
}
