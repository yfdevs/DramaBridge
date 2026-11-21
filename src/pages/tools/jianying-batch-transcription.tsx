import { useEffect, useState } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { jianying, type BatchTranscriptionState, type TranscriptionEpisode } from "@/platforms/jianying/service";

const labels = { waiting: "待识别", running: "识别中", success: "已完成", failed: "失败", cancelled: "已停止" };

export function JianyingBatchTranscription({ onRunningChange }: { onRunningChange: (running: boolean) => void }) {
  const [state, setState] = useState<BatchTranscriptionState>({ status: "idle", message: "选择剧集目录，自动读取视频和集数。", items: [] });
  const [items, setItems] = useState<TranscriptionEpisode[]>([]);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, receivedEvent = false;
    function receive(value: BatchTranscriptionState) {
      if (active) { setState(value); setItems(value.items); setReady(true); }
    }
    const unsubscribe = jianying.subscribeBatchTranscription(value => { receivedEvent = true; receive(value); });
    void jianying.batchTranscriptionState().then(value => { if (!receivedEvent) receive(value); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const running = state.status === "running";
  useEffect(() => { onRunningChange(running); }, [running, onRunningChange]);
  const selected = items.filter(item => item.selected);
  const duplicates = new Set<number>();
  const seen = new Set<number>();
  for (const item of selected) { if (seen.has(item.episode)) duplicates.add(item.episode); seen.add(item.episode); }
  const invalid = items.some(item => !Number.isInteger(item.episode) || item.episode < 1 || item.episode > 9999);
  const blocked = !ready || pending || running;
  async function action(work: () => Promise<unknown>) {
    setPending(true); setError("");
    try { await work(); } catch (reason) { setError(String(reason)); } finally { setPending(false); }
  }
  function edit(id: string, patch: Partial<TranscriptionEpisode>) {
    setError("");
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  }
  return <>
    <WorkspaceActions label="多集字幕识别操作">
      <Button size="sm" variant="outline" disabled={blocked} onClick={() => void action(() => jianying.chooseTranscriptionDirectory())}>选择剧集目录</Button>
      {running ? <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(() => jianying.cancelTranscription())}>停止识别</Button>
        : <Button size="sm" disabled={blocked || !selected.length || invalid || duplicates.size > 0} onClick={() => void action(() => jianying.transcribeBatch(items.map(({ id, episode, selected }) => ({ id, episode, selected }))))}>开始识别{selected.length ? `（${selected.length} 集）` : ""}</Button>}
      {state.output && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void action(() => jianying.openBatchTranscriptOutput())}>打开字幕目录</Button>}
    </WorkspaceActions>
    <div className="space-y-5">
      <p className="max-w-prose text-sm text-muted-foreground">选择直接包含剧集视频的目录，确认集数后点击“开始识别”。每集生成独立的 SRT 字幕和 TXT 文本。</p>
      {state.directory && <p className="break-all text-sm">剧集目录：{state.directory}</p>}
      {state.status === "failed" ? <p role="alert" className="text-sm text-destructive">{state.message}</p>
        : <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
          {running && <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />}{state.message}
        </p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {items.length ? <>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2">
            <label htmlFor="jianying-episode-count" className="text-sm">识别集数</label>
            <Input id="jianying-episode-count" type="number" min={0} max={items.length} step={1} value={selected.length} disabled={blocked} className="w-20" onChange={event => {
              const count = Number(event.target.value);
              if (Number.isInteger(count) && count >= 0 && count <= items.length) setItems(current => current.map((item, index) => ({ ...item, selected: index < count })));
            }} />
            <span className="text-sm text-muted-foreground">/ 共 {items.length} 集</span>
          </div>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => setItems(current => current.map(item => ({ ...item, selected: selected.length !== items.length })))}>{selected.length === items.length ? "取消全选" : "全选"}</Button>
          {!running && items.some(item => !item.detected) && <p className="text-xs text-muted-foreground">部分文件未识别出集号，已分配空余编号，请核对。</p>}
        </div>
        {invalid && <p role="alert" className="text-sm text-destructive">集数编号须为 1–9999 的整数。</p>}
        {duplicates.size > 0 && <p role="alert" className="text-sm text-destructive">第 {[...duplicates].join("、")} 集编号重复，请修改编号或取消勾选。</p>}
        <div className="max-h-[480px] overflow-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">剧集视频、集数编号及字幕识别进度</caption>
            <thead className="sticky top-0 z-10 bg-background text-muted-foreground"><tr className="border-b">
              <th scope="col" className="w-12 px-4 py-3"><span className="sr-only">选择</span></th>
              <th scope="col" className="w-28 px-3 py-3 font-medium">集数编号</th>
              <th scope="col" className="px-3 py-3 font-medium">视频文件</th>
              <th scope="col" className="w-48 px-3 py-3 font-medium">识别状态</th>
              <th scope="col" className="w-24 px-3 py-3 font-medium"><span className="sr-only">字幕文件</span></th>
            </tr></thead>
            <tbody>{items.map(item => <tr key={item.id} className="border-b last:border-0">
              <td className="px-4 py-3"><Checkbox aria-label={`选择 ${item.name}`} checked={item.selected} disabled={blocked} onCheckedChange={checked => edit(item.id, { selected: checked === true })} /></td>
              <td className="px-3 py-3"><Input aria-label={`${item.name} 的集数编号`} type="number" min={1} max={9999} step={1} value={item.episode || ""} disabled={blocked} aria-invalid={item.selected && (duplicates.has(item.episode) || item.episode < 1 || item.episode > 9999)} className="w-20" onChange={event => edit(item.id, { episode: Number(event.target.value), detected: true, status: "waiting", message: undefined, subtitlePath: undefined, textPath: undefined })} /></td>
              <td className="max-w-80 break-all px-3 py-3" title={item.source}>{item.name}</td>
              <td className="px-3 py-3"><span className={item.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{item.selected ? labels[item.status] : "未选择"}</span>{item.selected && item.message && <p className="mt-1 break-all text-xs text-muted-foreground">{item.message}</p>}</td>
              <td className="px-3 py-3">{item.subtitlePath && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void action(() => jianying.revealEpisodeSubtitle(item.id))}>定位字幕</Button>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </> : <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
        <FolderOpen aria-hidden="true" className="size-7 text-muted-foreground" />
        <p className="text-sm">选择剧集目录，自动读取全部视频</p>
        <p className="text-xs text-muted-foreground">支持“第01集”“EP01”“01”等命名，集数可手动修改</p>
        <Button size="sm" variant="outline" disabled={blocked} onClick={() => void action(() => jianying.chooseTranscriptionDirectory())}>选择目录</Button>
      </div>}
      {state.output && <p className="break-all text-xs text-muted-foreground">字幕目录：{state.output}</p>}
    </div>
  </>;
}
