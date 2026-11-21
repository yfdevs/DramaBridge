import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverflowText } from "@/components/ui/overflow-text";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { videoCompression as service, type CompressionState } from "@/platforms/video-separation/compression-service";

const mb = 1024 * 1024;
const size = (bytes: number) => `${(bytes / mb).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} MB`;
const labels = { ready: "待压缩", queued: "等待中", running: "压缩中", success: "已完成", "target-unmet": "未达标", failed: "失败", cancelled: "已停止" };

export function VideoCompressionPage() {
  const [state, setState] = useState<CompressionState>({ status: "idle", items: [], message: "添加视频后开始压缩。" });
  const [targetMB, setTargetMB] = useState("10");
  const [strictLossless, setStrictLossless] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, receivedEvent = false;
    const receive = (value: CompressionState) => {
      if (!active) return;
      setState(value); setReady(true);
      if (value.status === "running") {
        if (value.effort) setStrictLossless(value.effort !== "balanced");
        if (value.targetBytes) setTargetMB(String(value.targetBytes / mb));
      }
    };
    const unsubscribe = service.subscribe(value => { receivedEvent = true; receive(value); });
    void service.state().then(value => { if (!receivedEvent) receive(value); }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function action(work: () => Promise<unknown>) {
    setPending(true); setError("");
    try { await work(); } catch (reason) { setError(String(reason)); } finally { setPending(false); }
  }
  const running = state.status === "running";
  const targetBytes = Math.floor(Number(targetMB) * mb);
  const invalid = !Number.isSafeInteger(targetBytes) || targetBytes < 1024 || targetBytes > 1024 ** 4;
  const disabled = !ready || pending || running;
  const items = state.items ?? [];
  const completed = items.filter(item => item.status === "success").length;
  const originalBytes = items.reduce((total, item) => total + (item.source?.bytes ?? 0), 0);
  const savedBytes = items.reduce((total, item) => total + (item.result ? item.result.inputBytes - item.result.outputBytes : 0), 0);
  return <main className="video-compression-theme flex min-h-0 flex-1 flex-col gap-3 p-3 text-foreground">
    <WorkspaceActions label="批量压缩操作">
      <div className="video-compression-theme flex items-center gap-2 text-foreground">
      <div className="video-compression-theme flex items-center gap-2">
        <label htmlFor="compression-target" className="whitespace-nowrap text-sm">每个视频小于</label>
        <Input id="compression-target" type="number" min={0.001} max={1048576} step="any" value={targetMB} disabled={disabled} aria-invalid={invalid} onChange={event => setTargetMB(event.target.value)} className="h-7 w-20 tabular-nums" /><span className="text-sm text-muted-foreground">MB</span>
      </div>
      {running ? <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(() => service.cancel())}>停止全部</Button>
        : <Button size="sm" disabled={disabled || !items.some(item => item.source) || invalid} onClick={() => void action(() => service.start(targetBytes, strictLossless ? "fast" : "balanced"))}>开始压缩{items.length ? `（${items.filter(item => item.source).length}）` : ""}</Button>}
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void action(() => service.choose())}>添加视频</Button>
      <div className="video-compression-theme flex items-center gap-2 px-2"><Switch id="compression-lossless" checked={strictLossless} onCheckedChange={setStrictLossless} disabled={disabled} /><label htmlFor="compression-lossless" className="whitespace-nowrap text-sm">严格无损</label></div>
      {state.outputDirectory && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void action(() => service.openOutput())}><FolderOpen aria-hidden="true" />打开结果目录</Button>}
      </div>
    </WorkspaceActions>
    {strictLossless && <p className="text-sm text-muted-foreground">严格无损可能无法达到体积上限</p>}
    {invalid && <p role="alert" className="text-sm text-destructive">体积上限须在 1 KB 到 1 TB 之间</p>}
    {error && <p role="alert" className="break-all text-sm text-destructive">{error.replace(/[。.]$/, "")}</p>}
    <section aria-label="视频列表" className="flex min-h-0 flex-col gap-2" aria-busy={running}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums"><span>{items.length} 个视频</span><span className="text-muted-foreground">共 {size(originalBytes)}</span>{savedBytes > 0 && <span className="text-muted-foreground">已节省 {size(savedBytes)}</span>}</p>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void action(() => service.remove())}>清空列表</Button>
      </div>
      <div className="min-h-0 overflow-auto rounded-lg border">
        <table className="table-sticky-actions w-full min-w-[760px] table-fixed text-left text-xs leading-4">
          <caption className="sr-only">批量视频压缩进度与结果</caption>
          <colgroup><col /><col className="w-24" /><col className="w-24" /><col className="w-64" /><col className="w-16" /></colgroup>
          <thead className="bg-muted text-muted-foreground"><tr><th scope="col" className="h-8 px-2 py-1 font-medium">视频</th><th scope="col" className="h-8 px-2 py-1 text-right font-medium">原大小</th><th scope="col" className="h-8 px-2 py-1 text-right font-medium">输出大小</th><th scope="col" className="h-8 px-2 py-1 font-medium">状态</th><th scope="col" className="h-8 px-2 py-1 font-medium">操作</th></tr></thead>
          <tbody>{items.map(item => {
            const active = item.status === "running";
            const percent = Math.min(100, Math.max(0, item.progress?.percent ?? 0));
            const note = active ? item.message.replace(/^第一遍：/, "分析：").replace(/^第二遍：/, "编码：")
              : item.status === "failed" || item.status === "target-unmet" ? item.message.replace(/[。.]$/, "")
              : item.result?.method === "原样复制" ? "已原样保存" : "";
            return <tr key={item.id} className="h-9 border-t">
              <td className="px-2 py-1.5 align-middle"><div title={`${item.file}${item.source ? `\n${item.source.width} × ${item.source.height}，${Math.round(item.source.duration)} 秒` : ""}`}><OverflowText>{item.name}</OverflowText></div></td>
              <td className="px-2 py-1.5 text-right align-middle tabular-nums">{item.source ? size(item.source.bytes) : "—"}</td>
              <td className="px-2 py-1.5 text-right align-middle tabular-nums">{item.result ? size(item.result.outputBytes) : "—"}</td>
              <td className="px-2 py-1.5 align-middle">
                <div className="flex h-6 min-w-0 flex-col justify-center" title={note || undefined}>
                  <div className="flex h-5 shrink-0 items-center justify-between gap-2"><span className={`min-w-0 truncate ${item.status === "failed" || item.status === "target-unmet" ? "text-destructive" : ""}`}>{active ? note : labels[item.status]}</span><span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{active && item.progress?.percent !== undefined ? `${Math.floor(percent)}%` : ""}</span></div>
                  <div role="progressbar" aria-label={`${item.name} 当前步骤进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress?.percent === undefined ? undefined : percent} aria-hidden={!active} className={`h-1 shrink-0 overflow-hidden rounded-full bg-muted ${active ? "visible" : "invisible"}`}>
                    <div className="h-full rounded-full bg-primary transition-[width] duration-250 ease-out motion-reduce:transition-none" style={{ width: `${percent}%` }} />
                  </div>
                </div>
              </td>
              <td className="px-2 py-1.5 align-middle"><Button size="xs" variant="ghost" disabled={disabled} aria-label={`移除 ${item.name}`} onClick={() => void action(() => service.remove(item.id))}>移除</Button></td>
            </tr>;
          })}{!items.length && <tr><td colSpan={5} className="p-12 text-center text-muted-foreground">添加需要压缩的视频</td></tr>}</tbody>
        </table>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{running ? `已完成 ${completed} / ${items.length} 个` : state.message.replace(/[。.]$/, "")}</p>
    </section>
  </main>;
}
