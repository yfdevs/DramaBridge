import { useState } from "react";
import { toast } from "@/components/ui/notifications";
import type { TaskSweepResult } from "@dramabridge/automation-logging";
import { Button } from "@/components/ui/button";

export function ManualTaskCleanupButton({ onCleanup, onComplete, disabled }: {
  onCleanup: () => Promise<TaskSweepResult>;
  onComplete: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [processing, setProcessing] = useState(false);
  const cleanup = async () => {
    if (processing) return;
    setProcessing(true);
    try {
      const result = await onCleanup();
      if (result.busy) {
        toast.info("任务清理正在进行，请稍后再试");
        return;
      }
      const handled = result.failed + result.succeeded + result.released;
      const message = handled ? `已处理 ${handled} 个超时任务` : "暂无需要清理的超时任务";
      if (result.errors) toast.warning(`清理完成，${result.errors} 项处理失败`);
      else toast.success(message);
      await onComplete();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setProcessing(false); }
  };
  return (
    <Button size="sm" variant="outline" disabled={disabled || processing} aria-busy={processing}
      title="检查该平台全部账号和电脑领取的任务，清理连续4小时无变化的超时任务"
      onClick={() => void cleanup()}>
      {processing ? "正在清理…" : "清理超时任务"}
    </Button>
  );
}
