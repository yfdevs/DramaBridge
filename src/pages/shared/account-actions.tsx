import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";

export type AccountControls = {
  start: (id: string) => Promise<void>;
  pause: (id: string, paused: boolean) => Promise<void>;
  stop?: (id: string) => Promise<void>;
};

export function AccountActions({ id, name, launched, paused, controls, disabled = false }: {
  id: string; name: string; launched: boolean; paused?: boolean;
  controls: AccountControls; disabled?: boolean;
}) {
  const [pending, setPending] = useState<"start" | "pause" | "stop" | null>(null);
  const busy = useRef(false);
  const run = async (action: "start" | "pause" | "stop") => {
    if (busy.current) return;
    busy.current = true;
    setPending(action);
    try {
      if (action === "start") await controls.start(id);
      else if (action === "stop") await controls.stop?.(id);
      else await controls.pause(id, !paused);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
      setPending(null);
      window.dispatchEvent(new Event("app:service-changed"));
    }
  };
  const canStop = launched && Boolean(controls.stop);
  const label = canStop ? "停止" : launched ? (paused ? "继续领任务" : "暂停领任务") : "启动";
  return <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[620px]:w-42" role="group" aria-label={`${name}的操作`}>
    <Button size="sm" variant={canStop ? "secondary" : "outline"}
      className="min-w-16 text-xs"
      aria-busy={pending !== null}
      disabled={pending !== null || (!launched && disabled)}
      title={canStop ? "停止此账号浏览器，其他账号继续运行" : launched ? "暂停只停止领取新任务，当前任务继续完成" : "打开此账号浏览器，登录后自动开始任务"}
      onClick={() => void run(canStop ? "stop" : launched ? "pause" : "start")}>
      {pending === "start" ? "启动中…" : pending === "stop" ? "停止中…" : pending === "pause" ? "处理中…" : label}
    </Button>
    {canStop && <Button size="sm" variant="ghost" className="text-xs"
      disabled={pending !== null} onClick={() => void run("pause")}>
      {pending === "pause" ? "处理中…" : paused ? "继续领任务" : "暂停领任务"}
    </Button>}
  </div>;
}
