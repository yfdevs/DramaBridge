import { Folder } from "@mynaui/icons-react";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { videoSeparation as service } from "@/platforms/video-separation/service";
type Task = { id: string; directory: string; count: number; seconds: number; status: string; output?: string };
export function VideoSeparationPage() {
  const [directory, setDirectory] = useState("");
  const [seconds, setSeconds] = useState(45);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const update = (dir: string, patch: Partial<Task>) =>
    setTasks((current) => current.map((t) => (t.id === dir ? { ...t, ...patch } : t)));
  useEffect(() => service.subscribe(value => update(value.id, {status: value.message})), []);
  async function add() {
    setAdding(true);
    setError("");
    try {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
        throw new Error("请输入 1–3600 的整数秒数");
      if (tasks.some(t => t.directory === directory && t.seconds === seconds)) throw new Error('相同目录和秒数已在列表中');
      const result = await service.scan(directory);
      setTasks((current) => [...current, { ...result, id: crypto.randomUUID(), seconds, status: "待处理" }]);
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
        update(task.id, { status: "合并与分离中…" });
        try {
          const result = await service.run(task.directory, task.seconds, task.id);
          update(task.id, { output: result.output, status: `已完成 · ${result.count} 集` });
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
      <WorkspaceActions label="视频分离操作">
        <form
          className="flex w-full min-w-0 items-center gap-2"
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
          <div>
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
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
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
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 overflow-auto rounded-lg border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-3 py-2">目录</th>
              <th className="px-3 py-2">集数</th>
              <th className="px-3 py-2">秒 / 集</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="max-w-80 break-all px-3 py-2">{t.directory}</td>
                <td className="px-3 py-2">{t.count}</td>
                <td className="px-3 py-2">{t.seconds}</td>
                <td className="max-w-80 break-words px-3 py-2" aria-live="polite">
                  {t.status}
                </td>
                <td className="px-3 py-2">
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
                <td colSpan={5} className="p-12 text-center text-muted-foreground">
                  选择视频目录并添加，开始创建分离任务。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
