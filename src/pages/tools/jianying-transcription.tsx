import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { useEffect, useState } from "react";
import { LoaderIcon as LoaderCircle } from "@/components/ui/solar-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { jianying, type TranscriptionState } from "@/platforms/jianying/service";
import { JianyingBatchTranscription } from "./jianying-batch-transcription";

export function JianyingTranscription({ parentError }: { parentError: string }) {
  const [state, setState] = useState<TranscriptionState>({ status: "idle", message: "正在加载识别状态" });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"batch" | "single">("batch");
  const [batchRunning, setBatchRunning] = useState(false);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = jianying.subscribeTranscription(value => {
      receivedEvent = true;
      if (active) { setState(value); setReady(true); setNotice(""); if (value.status === "running") setMode("single"); }
    });
    void jianying.transcriptionState().then(value => {
      if (active) { if (!receivedEvent) { setState(value); if (value.status === "running") setMode("single"); } setReady(true); }
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function action(work: () => Promise<unknown>) {
    setPending(true); setError(""); setNotice("");
    try { await work(); } catch (reason) { setError(String(reason)); } finally { setPending(false); }
  }
  const running = state.status === "running";
  const complete = state.status === "success";
  const filename = state.source?.split(/[\\/]/).pop();
  return <>
    {mode === "single" && <WorkspaceActions label="视频转文字操作">
      <Button size="sm" disabled={!ready || pending || running} onClick={() => void action(() => jianying.transcribe())}>选择视频并识别</Button>
      {running && <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(() => jianying.cancelTranscription())}>停止识别</Button>}
      {complete && <>
        <Button size="sm" variant="outline" disabled={pending || !state.text} onClick={() => void action(async () => { await jianying.copyTranscript(); setNotice("已复制全部文字"); })}>复制文字</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(async () => { if (await jianying.saveTranscript("txt")) setNotice("文本已保存"); })}>另存为 TXT</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(async () => { if (await jianying.saveTranscript("srt")) setNotice("字幕已保存"); })}>另存为 SRT</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void action(() => jianying.openTranscriptOutput())}>打开结果目录</Button>
      </>}
    </WorkspaceActions>}
    <section aria-labelledby="jianying-transcription-title" aria-busy={running || batchRunning} className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 p-3">
      <div className="space-y-2">
        <h2 id="jianying-transcription-title" className="text-base font-semibold">视频转文字</h2>
        <p className="max-w-prose text-sm text-muted-foreground">使用剪映账号生成字幕，请先在剪映中登录</p>
      </div>
      <div role="group" aria-label="识别模式" className="flex items-center gap-2">
        <Button size="sm" variant="state" data-active={mode === "batch" ? "" : undefined} aria-pressed={mode === "batch"} disabled={pending || running || batchRunning} onClick={() => setMode("batch")}>多集识别</Button>
        <Button size="sm" variant="state" data-active={mode === "single" ? "" : undefined} aria-pressed={mode === "single"} disabled={pending || running || batchRunning} onClick={() => setMode("single")}>单个视频</Button>
      </div>
      {mode === "batch" ? <JianyingBatchTranscription onRunningChange={setBatchRunning} /> : <>
      {filename && <p className="break-all text-sm" title={state.source}>当前视频：{filename}</p>}
      {state.status === "failed" ? <p role="alert" className="text-sm text-destructive">{state.message}</p>
        : <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
          {running && <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />}
          {state.message}
        </p>}
      {(error || parentError) && <p role="alert" className="text-sm text-destructive">{error || parentError}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {complete ? <div className="space-y-2">
        <label htmlFor="jianying-transcript-text" className="text-sm font-medium">识别文字</label>
        <Textarea id="jianying-transcript-text" readOnly value={state.text ?? ""} className="h-[min(52vh,560px)] min-h-64 resize-y [field-sizing:fixed] leading-relaxed" placeholder="未检测到可识别的语音" />
        {state.text?.length === 100_000 && <p className="text-xs text-muted-foreground">页面仅预览前 10 万字，复制和导出的文件包含全部文字</p>}
        <p className="break-all text-xs text-muted-foreground">文件已保存至：{state.output}</p>
      </div> : !running && state.status === "idle" ? <EmptyStateCard
        className="min-h-64"
        title="选择一个视频，开始提取对白"
        description="支持 MP4、MOV、MKV 等视频格式"
      /> : null}
      </>}
    </section>
  </>;
}
