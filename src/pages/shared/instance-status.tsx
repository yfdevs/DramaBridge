import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";
import type { AccountControls } from "./account-selection";

function InstanceControlButton({
  id,
  name,
  launched,
  paused,
  controls,
}: {
  id: string;
  name: string;
  launched: boolean;
  paused?: boolean;
  controls: AccountControls;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-label={`${launched ? (paused ? "恢复账号" : "暂停账号") : "启动账号"} ${name}`}
      title={launched && !paused ? "停止领取新任务，已领取任务继续完成" : undefined}
      onClick={() => {
        if (pending) return;
        setPending(true);
        void (launched ? controls.pause(id, !paused) : controls.start(id))
          .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
          .finally(() => setPending(false));
      }}
    >
      {pending ? "处理中…" : launched ? (paused ? "恢复" : "暂停") : "启动"}
    </Button>
  );
}

export function InstanceStatus({
  launched,
  loginState,
  label,
  paused = false,
}: {
  launched: boolean;
  loginState?: string;
  label?: string;
  paused?: boolean;
}) {
  const state = !launched
    ? "idle"
    : paused
      ? "waiting"
      : loginState === "logged-in"
        ? "ready"
        : loginState === "login-required"
          ? "waiting"
          : "open";
  const text = !launched
    ? "未启动"
    : paused
      ? "已暂停领取"
      : loginState === "logged-in"
        ? "已登录"
        : loginState === "login-required"
          ? "等待登录"
          : label || "浏览器已打开";
  return (
    <Badge
      variant="secondary"
      data-state={state}
      className="instance-status shrink-0 gap-1.5 text-xs font-normal"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {text}
    </Badge>
  );
}

export function SingleInstance({
  running,
  loginState,
  name = "默认实例",
}: {
  running: boolean;
  loginState?: string;
  name?: string;
}) {
  return (
    <section aria-label="浏览器实例" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>1 个实例</span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4 rounded-md bg-muted/40 px-4 py-5">
        <span className="min-w-0 break-words text-sm font-medium">{name}</span>
        <InstanceStatus launched={running} loginState={loginState} />
      </div>
      {running && loginState === "login-required" && (
        <p className="text-xs text-muted-foreground">请在已打开的浏览器中完成登录</p>
      )}
    </section>
  );
}

export function RuntimeInstances({
  instances,
  running,
  controls,
}: {
  instances: Array<{
    id: string;
    name: string;
    launched: boolean;
    loginState: string;
    pageCount?: number;
    paused?: boolean;
  }>;
  running: boolean;
  controls?: AccountControls;
}) {
  return (
    <section aria-label="浏览器实例" className="flex min-w-0 flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        共 {instances.length} 个实例，运行中{" "}
        {instances.filter((instance) => instance.launched).length} 个
      </p>
      {instances.length ? (
        <ul className="flex min-w-0 flex-col gap-1" aria-label="实例列表">
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md px-3 py-4 hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-medium">{instance.name || instance.id}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">ID {instance.id}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <InstanceStatus
                  launched={instance.launched}
                  loginState={instance.loginState}
                  paused={instance.paused}
                />
                {instance.launched && instance.pageCount !== undefined && (
                  <span className="text-xs text-muted-foreground">{instance.pageCount} 个页面</span>
                )}
                {controls && <InstanceControlButton {...instance} controls={controls} />}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="py-12 text-center text-sm text-muted-foreground">
          {running ? "暂无可用实例，请检查后台账号配置" : "启动服务后显示账号实例"}
        </p>
      )}
    </section>
  );
}
