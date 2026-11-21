import { useNotification } from "@/hooks/use-notification";
import { OverflowText } from "@/components/ui/overflow-text";
import { InfoIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Folder } from "@mynaui/icons-react";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { WorkspaceActions, WorkspaceNavigation, WorkspacePageActivity, useWorkspacePageActive } from "@/components/workspace-toolbar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VideoCompressionPage } from "./video-compression";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { videoSeparation as service } from "@/platforms/video-separation/service";
type Task = { id: string; directory: string; count: number; seconds: number; mergeAndSplit: boolean; status: string; output?: string };
export function VideoSeparationPage() {
  const [tab, setTab] = useState("processing");
  const active = useWorkspacePageActive();
  return <Tabs value={tab} onValueChange={value => setTab(String(value))} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <WorkspaceNavigation label="视频处理页面"><TabsList variant="line"><TabsTrigger value="processing">视频处理</TabsTrigger><TabsTrigger value="compression">视频压缩</TabsTrigger></TabsList></WorkspaceNavigation>
    <TabsContent value="processing" keepMounted className="min-h-0 data-[hidden]:hidden"><WorkspacePageActivity active={active && tab === "processing"}><VideoProcessingTasks /></WorkspacePageActivity></TabsContent>
    <TabsContent value="compression" keepMounted className="min-h-0 data-[hidden]:hidden"><WorkspacePageActivity active={active && tab === "compression"}><VideoCompressionPage /></WorkspacePageActivity></TabsContent>
  </Tabs>;
}

function VideoProcessingTasks() {
  const [directory, setDirectory] = useState("");
  const [seconds, setSeconds] = useState(45);
  const [mergeAndSplit, setMergeAndSplit] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  useNotification(error, "error", "操作失败");
  const update = (dir: string, patch: Partial<Task>) =>
    setTasks((current) => current.map((t) => (t.id === dir ? { ...t, ...patch } : t)));
  useEffect(() => service.subscribe(value => update(value.id, {status: value.message})), []);
  async function add() {
    setAdding(true);
    setError("");
    try {
      if (mergeAndSplit && (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600))
        throw new Error("请输入 1–3600 的整数秒数");
      if (tasks.some(t => t.directory === directory && t.mergeAndSplit === mergeAndSplit && (!mergeAndSplit || t.seconds === seconds))) throw new Error('相同目录和处理设置已在列表中');
      const result = await service.scan(directory);
      setTasks((current) => [...current, { ...result, id: crypto.randomUUID(), seconds, mergeAndSplit, status: "待处理" }]);
      setDirectory("");
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }
  async function run() {
    setBusy(true);
    setError("");
    try {
      for (const task of tasks.filter((t) => !t.output)) {
        update(task.id, { status: task.mergeAndSplit ? "合并与分割中…" : "检查与优化码率中…" });
        try {
          const result = await service.run(task.directory, task.seconds, task.id, task.mergeAndSplit);
          update(task.id, { output: result.output, status: `已完成，${result.count} 集` });
        } catch (e) {
          update(task.id, { status: "失败：" + String(e) });
        }
      }
    } finally {
      setBusy(false); setPaused(false);
    }
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <WorkspaceActions label="视频处理操作">
        <form
          className="flex w-full min-w-0 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="min-w-0 max-w-xl flex-1">
            <label className="sr-only" htmlFor="video-directory">
              视频目录
            </label>
            <InputGroup className="h-7">
              <InputGroupInput
                id="video-directory"
                className="text-xs md:text-xs"
                value={directory}
                readOnly
                placeholder="选择包含剧集视频的目录"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="xs"
                  type="button"
                  aria-label="选择视频目录"
                  className="text-xs"
                  disabled={adding}
                  onClick={async () => {
                    try {
                      const selected = await service.choose();
                      if (selected) setDirectory(selected);
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <Folder />
                  选择
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Switch id="video-merge-split" checked={mergeAndSplit} onCheckedChange={setMergeAndSplit} disabled={adding} />
            <label htmlFor="video-merge-split" className="text-xs">合并并分割</label>
            <Tooltip>
              <TooltipTrigger render={<Button type="button" size="icon-sm" variant="ghost" className="text-muted-foreground" />}>
                <InfoIcon className="size-3.5" />
                <span className="sr-only">处理说明</span>
              </TooltipTrigger>
              <TooltipContent>
                {mergeAndSplit ? "合并视频后按设定时长分割，并校验码率。" : "保留原集数和时长，仅优化低于 4 Mbps 或无法读取码率的视频，合格视频原样复制。"}
                结果保存到同级新目录，保留原视频。
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-1">
            <label htmlFor="video-seconds" className="sr-only">
              每集秒数
            </label>
            <Input
              id="video-seconds"
              type="number"
              min={1}
              max={3600}
              step={1}
              className="h-7 w-20 text-xs md:text-xs"
              aria-label="每集秒数"
              value={seconds}
              disabled={!mergeAndSplit || adding}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
            <span className="text-xs text-muted-foreground">秒 / 集</span>
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!directory || adding}>
            {adding ? "扫描中…" : "添加"}
          </Button>
          <span aria-hidden="true" className="ml-auto mx-1 h-4 w-px shrink-0 bg-border" />
          <Button
            type="button"
            size="sm"
            disabled={busy || adding || !tasks.some((t) => !t.output)}
            onClick={() => void run()}
          >
            {busy ? "处理中…" : "开始处理"}
          </Button>
          {busy && <Button type="button" size="sm" variant="outline" onClick={async () => {try {await service.pause(!paused);setPaused(!paused);}catch(e){setError(String(e));}}}>{paused ? '继续' : '暂停'}</Button>}
        </form>
      </WorkspaceActions>
      <div className="min-h-0 overflow-auto rounded-lg border">
        <table className="table-sticky-actions w-full min-w-[760px] table-fixed text-left text-xs leading-4">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="h-8 px-2 py-1 font-medium">目录</th>
              <th className="h-8 w-16 px-2 py-1 font-medium">集数</th>
              <th className="h-8 w-40 px-2 py-1 font-medium">处理方式</th>
              <th className="h-8 w-20 px-2 py-1 font-medium">秒 / 集</th>
              <th className="h-8 w-48 px-2 py-1 font-medium">状态</th>
              <th className="h-8 w-24 px-2 py-1 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-2 py-1.5"><OverflowText>{t.directory}</OverflowText></td>
                <td className="px-2 py-1.5">{t.count}</td>
                <td className="px-2 py-1.5">{t.mergeAndSplit ? "合并分割并优化码率" : "仅检查并优化码率"}</td>
                <td className="px-2 py-1.5">{t.mergeAndSplit ? t.seconds : "—"}</td>
                <td className="px-2 py-1.5" aria-live="polite">
                  <OverflowText>{t.status}</OverflowText>
                </td>
                <td className="px-2 py-1.5">
                  {t.output ? (
                    <Button size="xs" variant="ghost" onClick={() => void service.open(t.output!)}>
                      打开结果
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setTasks((current) =>
                          current.filter((item) => item.id !== t.id),
                        )
                      }
                    >
                      移除
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!tasks.length && (
              <tr>
                <td colSpan={6} className="p-12 text-center text-muted-foreground">
                  选择视频目录和处理方式后添加任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
