import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle, Chrome, DangerTriangle } from "@mynaui/icons-react";
import { toast } from "@/components/ui/notifications";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  wechatMiniProgramBaiduUploadService,
  type WechatMiniProgramDirectUploadTask,
  type WechatMiniProgramDirectUploadTaskState,
  type WechatMiniProgramDirectUploadWorkspace,
} from "@/platforms/wechat-miniprogram-drama/baidu-upload-service";

const stateLabels: Record<WechatMiniProgramDirectUploadTaskState, string> = {
  queued: "等待处理",
  inspecting: "检查资源",
  downloading: "下载中",
  "waiting-login": "等待登录",
  uploading: "上传中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function stateVariant(state: WechatMiniProgramDirectUploadTaskState) {
  if (state === "completed") return "secondary" as const;
  if (state === "failed" || state === "interrupted") return "destructive" as const;
  if (["inspecting", "downloading", "waiting-login", "uploading"].includes(state)) {
    return "default" as const;
  }
  return "outline" as const;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function browserLabel(workspace: WechatMiniProgramDirectUploadWorkspace) {
  switch (workspace.browser.loginState) {
    case "logged-in":
      return "微信已登录";
    case "login-required":
      return "等待微信登录";
    case "unknown":
      return "正在确认登录";
    default:
      return "微信浏览器未打开";
  }
}

function TaskProgress({ task }: { task: WechatMiniProgramDirectUploadTask }) {
  if (task.state === "uploading") {
    const total = Math.max(1, task.uploadTotalCount);
    const value = Math.round((task.uploadCompletedCount / total) * 100);
    return (
      <div className="grid min-w-32 gap-1.5">
        <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
          <span>
            上传 {task.uploadCompletedCount}/{task.uploadTotalCount}
          </span>
          <span className="text-muted-foreground">{value}%</span>
        </div>
        <Progress aria-label={`上传进度 ${value}%`} value={value} />
      </div>
    );
  }
  if (task.state === "downloading") {
    return <span className="text-xs text-muted-foreground">正在检查并下载资源</span>;
  }
  if (task.state === "completed") {
    return <span className="text-xs">{task.uploadTotalCount} 集已上传</span>;
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

export function WechatMiniProgramBaiduUploadWindow() {
  const [workspace, setWorkspace] = useState<WechatMiniProgramDirectUploadWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dramaName, setDramaName] = useState("");
  const [shareText, setShareText] = useState("");

  const refresh = useCallback(async (silent = false) => {
    try {
      setWorkspace(await wechatMiniProgramBaiduUploadService.workspace());
    } catch (error) {
      if (!silent) {
        toast.error("无法读取直传任务", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = wechatMiniProgramBaiduUploadService.onWorkspaceChanged(setWorkspace);
    const interval = window.setInterval(() => void refresh(true), 3000);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    let restoreWindowControlsTimer: number | undefined;
    if (drawerOpen) {
      document.documentElement.dataset.directUploadDrawerOpen = "true";
    } else {
      restoreWindowControlsTimer = window.setTimeout(() => {
        delete document.documentElement.dataset.directUploadDrawerOpen;
      }, 500);
    }
    return () => {
      if (restoreWindowControlsTimer !== undefined) {
        window.clearTimeout(restoreWindowControlsTimer);
      }
    };
  }, [drawerOpen]);

  useEffect(
    () => () => {
      delete document.documentElement.dataset.directUploadDrawerOpen;
    },
    [],
  );

  const queuedTaskCount = useMemo(
    () => workspace?.tasks.filter((task) => task.state === "queued").length ?? 0,
    [workspace],
  );

  const runAction = async (
    key: string,
    action: () => Promise<WechatMiniProgramDirectUploadWorkspace>,
    success?: string,
  ) => {
    if (pendingAction) return false;
    setPendingAction(key);
    try {
      setWorkspace(await action());
      if (success) toast.success(success);
      return true;
    } catch (error) {
      toast.error("操作失败", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const created = await runAction(
      "create",
      () => wechatMiniProgramBaiduUploadService.createTask({ dramaName, shareText }),
      "任务已创建并开始处理",
    );
    if (created) {
      setDramaName("");
      setShareText("");
      setDrawerOpen(false);
    }
  };

  if (loading && !workspace) {
    return (
      <main className="grid h-full place-items-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 正在读取直传任务
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b bg-background px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <img
                alt=""
                className="size-5"
                src={`${import.meta.env.BASE_URL}wechat-miniprogram.svg`}
              />
              <h1 className="text-base font-semibold">百度资源直传</h1>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              自动检查并下载连续剧集，只上传到当前登录账号的视频素材库，不创建剧目、不提交审核
            </p>
          </div>
          <Button type="button" size="sm" onClick={() => setDrawerOpen(true)}>
            新建任务
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${
                workspace?.browser.loginState === "logged-in"
                  ? "bg-emerald-500"
                  : workspace?.browser.loginState === "login-required"
                    ? "bg-amber-500"
                    : "bg-muted-foreground/40"
              }`}
            />
            {workspace ? browserLabel(workspace) : "正在检查浏览器"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${workspace?.queue.running ? "bg-sky-500" : "bg-muted-foreground/40"}`}
            />
            {workspace?.queue.running ? "队列运行中" : "队列已暂停"}
          </span>
          <span className="text-muted-foreground">待处理 {queuedTaskCount} 个</span>
          {workspace?.queue.error ? (
            <span className="max-w-64 truncate text-destructive" title={workspace.queue.error}>
              {workspace.queue.error}
            </span>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={pendingAction !== null}
              onClick={() =>
                void runAction("focus-browser", () =>
                  wechatMiniProgramBaiduUploadService.focusBrowser(),
                )
              }
            >
              <Chrome className="size-3.5" />
              {workspace?.browser.launched ? "打开微信浏览器" : "打开微信登录"}
            </Button>
            {workspace?.browser.launched ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={pendingAction !== null || Boolean(workspace.queue.activeTaskId)}
                onClick={() =>
                  void runAction(
                    "close-browser",
                    () => wechatMiniProgramBaiduUploadService.closeBrowser(),
                    "直传浏览器已关闭",
                  )
                }
              >
                关闭浏览器
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant={workspace?.queue.running ? "outline" : "default"}
              disabled={
                pendingAction !== null || (!workspace?.queue.running && queuedTaskCount === 0)
              }
              onClick={() =>
                void runAction(
                  "queue",
                  workspace?.queue.running
                    ? () => wechatMiniProgramBaiduUploadService.pauseQueue()
                    : () => wechatMiniProgramBaiduUploadService.startQueue(),
                  workspace?.queue.running ? "当前任务结束后暂停" : "队列已开始",
                )
              }
            >
              {workspace?.queue.running ? "暂停接续" : "开始队列"}
            </Button>
            {workspace?.queue.activeTaskId ? (
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={pendingAction !== null}
                onClick={() =>
                  void runAction(
                    "cancel-active",
                    () => wechatMiniProgramBaiduUploadService.cancelActiveTask(),
                    "当前任务已终止",
                  )
                }
              >
                <DangerTriangle className="size-3.5" />
                终止当前任务
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {workspace && workspace.tasks.length > 0 ? (
          <div className="overflow-hidden rounded-lg border">
            <Table className="min-w-[820px] table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-background">
                  <TableHead className="w-12 text-center">序号</TableHead>
                  <TableHead>剧目</TableHead>
                  <TableHead className="w-24">集数</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-44">进度</TableHead>
                  <TableHead className="w-28">更新时间</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspace.tasks.map((task) => {
                  const active = workspace.queue.activeTaskId === task.id;
                  return (
                    <TableRow key={task.id} className={active ? "bg-muted/45" : undefined}>
                      <TableCell className="text-center text-xs tabular-nums text-muted-foreground">
                        {task.queueOrder}
                      </TableCell>
                      <TableCell className="min-w-0">
                        <div className="truncate text-sm font-medium" title={task.dramaName}>
                          {task.dramaName}
                        </div>
                        <div
                          className="mt-0.5 truncate text-[11px] text-muted-foreground"
                          title={task.error || task.localPath}
                        >
                          {task.error || ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {task.inferredEpisodeCount ? `${task.inferredEpisodeCount} 集` : "自动识别"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={stateVariant(task.state)}>
                          {active && !["failed", "completed", "interrupted"].includes(task.state) ? (
                            <Spinner className="size-3" />
                          ) : task.state === "completed" ? (
                            <CheckCircle className="size-3" />
                          ) : ["failed", "interrupted"].includes(task.state) ? (
                            <DangerTriangle className="size-3" />
                          ) : null}
                          {stateLabels[task.state]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <TaskProgress task={task} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(task.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {["failed", "interrupted"].includes(task.state) ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={pendingAction !== null}
                              onClick={() =>
                                void runAction(
                                  `retry:${task.id}`,
                                  () => wechatMiniProgramBaiduUploadService.retryTask(task.id),
                                  "任务已重新开始处理",
                                )
                              }
                            >
                              重试
                            </Button>
                          ) : null}
                          {!active ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              className="text-destructive"
                              disabled={pendingAction !== null}
                              onClick={() =>
                                void runAction(`delete:${task.id}`, () =>
                                  wechatMiniProgramBaiduUploadService.deleteTask(task.id),
                                )
                              }
                            >
                              删除
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="grid min-h-64 place-items-center rounded-lg border border-dashed px-6 text-center">
            <div className="max-w-sm">
              <h2 className="text-sm font-medium">还没有直传任务</h2>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                新建任务时只需填写剧目名称和百度分享内容。系统会自动识别总集数并检查中间是否缺集
              </p>
              <Button className="mt-4" size="sm" type="button" onClick={() => setDrawerOpen(true)}>
                新建第一个任务
              </Button>
            </div>
          </div>
        )}
      </section>

      <footer className="shrink-0 border-t px-5 py-2 text-[11px] text-muted-foreground">
        关闭此窗口不会停止正在执行的任务
      </footer>

      <Drawer swipeDirection="right" open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent className="[--drawer-content-width:min(420px,92vw)] data-[swipe-axis=x]:[--drawer-content-width:min(420px,92vw)] data-[swipe-axis=x]:sm:[--drawer-content-width:420px] motion-reduce:transition-none">
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleCreate}>
            <DrawerHeader className="border-b px-5 py-4">
              <DrawerTitle>新建直传任务</DrawerTitle>
              <DrawerDescription className="leading-5">
                资源下载完成后，将按队列顺序上传到当前微信登录账号
              </DrawerDescription>
            </DrawerHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="direct-upload-drama-name">
                  剧目名称
                </label>
                <Input
                  id="direct-upload-drama-name"
                  autoFocus
                  value={dramaName}
                  onChange={(event) => setDramaName(event.target.value)}
                  placeholder="用于本地目录和上传文件名"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="direct-upload-share-text">
                  百度网盘分享内容
                </label>
                <Textarea
                  id="direct-upload-share-text"
                  className="min-h-40 resize-y leading-5"
                  value={shareText}
                  onChange={(event) => setShareText(event.target.value)}
                  placeholder="粘贴包含分享链接和提取码的完整文本"
                />
              </div>
              <div className="rounded-lg bg-muted/60 px-3 py-3 text-xs leading-5 text-muted-foreground">
                无需填写总集数。系统按第 1
                集到识别出的最大集数检查连续性；发现缺集或重复集数时，任务会在下载前失败
              </div>
              <div className="rounded-lg border px-3 py-3 text-xs leading-5">
                此功能只进入微信“视频上传”页面，不会填写剧目信息，也不会提交审核
              </div>
            </div>
            <DrawerFooter className="border-t px-5 py-4">
              <Button
                type="submit"
                disabled={pendingAction !== null || !dramaName.trim() || !shareText.trim()}
              >
                {pendingAction === "create" ? <Spinner /> : null}
                加入任务队列
              </Button>
              <DrawerClose className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                取消
              </DrawerClose>
            </DrawerFooter>
          </form>
        </DrawerContent>
      </Drawer>
    </main>
  );
}
