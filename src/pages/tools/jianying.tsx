import { useEffect, useState } from "react";
import { DangerTriangleIcon as TriangleAlert } from "@/components/ui/solar-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { toast } from "@/components/ui/notifications";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkspaceActions, WorkspaceNavigation } from "@/components/workspace-toolbar";
import { jianying, DEFAULT_WORKBENCH_RANGES, type WorkbenchRanges, type JianyingState, type JianyingQueueState } from "@/platforms/jianying/service";

import { ConfigurationPageFrame, ConfigPanelSection } from "@/pages/shared/configuration-page";
import { JianyingQueue } from "./jianying-queue";
import { JianyingTranscription } from "./jianying-transcription";

export function JianyingPage() {
  const [tab,setTab]=useState<"config"|"queue"|"transcription">("queue");
  const [queueLoading, setQueueLoading] = useState(true);
  const [queue,setQueue]=useState<JianyingQueueState>({running:false,tasks:[]});
  const [min, setMin] = useState(15);
  const [max, setMax] = useState(30);
  const [ranges, setRanges] = useState<WorkbenchRanges>({...DEFAULT_WORKBENCH_RANGES});
  const [state, setState] = useState<JianyingState>({ status: "idle", message: "选择剧集目录，然后点击启动处理", logs: [] });
  const [saved,setSaved]=useState({minSeconds:15,maxSeconds:30,...DEFAULT_WORKBENCH_RANGES});
  const config={minSeconds:min,maxSeconds:max,...ranges};
  const changed=JSON.stringify(config)!==JSON.stringify(saved);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const busy = pending || state.status === "running";
  useEffect(() => {
    let active = true;
    const unsubscribeQueue=jianying.subscribeQueue(value=>{if(active) setQueue(value);});
    void jianying.queueState()
      .then(value => { if (active) setQueue(value); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setQueueLoading(false); });
    const unsubscribe = jianying.subscribe(value => { if (active) setState(value); });
    void Promise.all([jianying.settings(), jianying.state()]).then(([settings, current]) => {
      if (!active) return;
      setMin(Math.min(60, Math.max(6, settings.minSeconds))); setMax(Math.min(60, Math.max(6, settings.maxSeconds)));
      setRanges({ videoBlocksMin: settings.videoBlocksMin ?? 8, videoBlocksMax: settings.videoBlocksMax ?? 14, audioBlocksMin: settings.audioBlocksMin ?? 20, audioBlocksMax: settings.audioBlocksMax ?? 40 });
      setSaved({minSeconds:Math.min(60,Math.max(6,settings.minSeconds)),maxSeconds:Math.min(60,Math.max(6,settings.maxSeconds)),videoBlocksMin:settings.videoBlocksMin,videoBlocksMax:settings.videoBlocksMax,audioBlocksMin:settings.audioBlocksMin,audioBlocksMax:settings.audioBlocksMax});
      setState(current); setReady(true);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); unsubscribeQueue(); };
  }, []);
  async function action(work: () => Promise<unknown>) {
    setPending(true); setError("");
    try { await work(); } catch (reason) { setError(String(reason)); } finally { setPending(false); }
  }
  const saveConfiguration = () => {
    void action(async () => {
      try {
        await jianying.saveSettings(min, max, ranges);
        setSaved(config);
        toast.success("配置已保存");
      } catch (reason) {
        toast.error("配置保存失败", {
          description: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });
  };
  const invalidRange = min < 6 || max > 60 || min > max || !Number.isFinite(min + max)
    || ranges.videoBlocksMin > ranges.videoBlocksMax || ranges.audioBlocksMin > ranges.audioBlocksMax
    || [ranges.videoBlocksMin, ranges.videoBlocksMax].some(value => !Number.isInteger(value) || value < 2 || value > 60)
    || [ranges.audioBlocksMin, ranges.audioBlocksMax].some(value => !Number.isInteger(value) || value < 2 || value > 80);
  return <Tabs
    value={tab}
    onValueChange={(value) => {
      if (value === "queue" || value === "transcription" || value === "config") setTab(value);
    }}
    className="min-h-0 min-w-0 flex-1 overflow-auto bg-background"
  >
    {tab==="queue" ? <WorkspaceActions label="剪映工具操作">
      <Button size="sm" variant="outline" disabled={!ready || busy} onClick={() => void action(() => jianying.launch())}>打开剪映</Button>
      <Button size="sm" variant="outline" disabled={!ready || pending} onClick={() => setTab("transcription")}>字幕识别</Button>
      {tab==="queue" ? <>
        <Button size="sm" variant="outline" disabled={!ready || pending || invalidRange} onClick={()=>void action(async()=>{const selected=await jianying.chooseSource(); if(selected) await jianying.addTask(selected,saved.minSeconds,saved.maxSeconds,saved);})}>添加任务</Button>
        {queue.running ? <Button size="sm" variant="outline" disabled={pending} onClick={()=>void action(()=>jianying.pauseQueue())}>暂停队列</Button>
          : <Button size="sm" disabled={!ready || busy || !queue.tasks.some(task=>task.status==="waiting")} onClick={()=>void action(()=>jianying.startQueue())}>启动队列</Button>}
        {state.status==="running" && <Button size="sm" variant="outline" disabled={pending} onClick={()=>void action(()=>jianying.cancel())}>停止当前任务</Button>}
      </> : null}
    </WorkspaceActions> : null}
    <WorkspaceNavigation label="剪映页面">
      <TabsList aria-label="剪映页面">
        <TabsTrigger value="queue">分轨生成</TabsTrigger>
        <TabsTrigger value="transcription">视频转文字</TabsTrigger>
        <TabsTrigger value="config">配置管理</TabsTrigger>
      </TabsList>
    </WorkspaceNavigation>
    <TabsContent key={tab} value={tab} className="min-h-0">
    {tab==="transcription" ? <JianyingTranscription parentError={error} /> : tab==="queue" ? <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 p-3">
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <JianyingQueue queue={queue} loading={queueLoading} pending={pending} action={action} />
      <Alert variant="warning" className="border-0 p-0"><TriangleAlert aria-hidden="true" /><AlertDescription className="text-xs">处理中请勿操作剪映或移动鼠标</AlertDescription></Alert>
    </div> : <ConfigurationPageFrame title="剪映配置" hasChanges={changed} loading={!ready || pending} saveDisabled={invalidRange}
      onDiscard={()=>{setMin(saved.minSeconds);setMax(saved.maxSeconds);setRanges({videoBlocksMin:saved.videoBlocksMin,videoBlocksMax:saved.videoBlocksMax,audioBlocksMin:saved.audioBlocksMin,audioBlocksMax:saved.audioBlocksMax});}}
      onClose={()=>setTab("queue")}
      onSave={saveConfiguration}>
      <ConfigPanelSection title="素材与轨道" description="">
        <fieldset disabled={!ready || pending} className="min-w-0">
          {([
            {id:"duration",label:"素材分割时长",value:[min,max],lower:6,upper:60,step:0.5,unit:"秒",update:(value:number[])=>{setMin(value[0]);setMax(value[1]);}},
            {id:"video",label:"视频片段总数",value:[ranges.videoBlocksMin,ranges.videoBlocksMax],lower:2,upper:60,step:1,unit:"个",update:(value:number[])=>setRanges(current=>({...current,videoBlocksMin:value[0],videoBlocksMax:value[1]}))},
            {id:"audio",label:"音频片段总数",value:[ranges.audioBlocksMin,ranges.audioBlocksMax],lower:2,upper:80,step:1,unit:"个",update:(value:number[])=>setRanges(current=>({...current,audioBlocksMin:value[0],audioBlocksMax:value[1]}))},
          ]).map(field=><Field key={field.id} className="gap-2 py-2.5 @min-[620px]:grid @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] @min-[620px]:gap-x-6 @min-[620px]:items-center">
            <FieldContent><FieldLabel id={`jianying-${field.id}`} className="text-sm font-normal">{field.label}</FieldLabel></FieldContent>
            <div className="flex min-w-0 items-center gap-4">
              <Slider aria-labelledby={`jianying-${field.id}`} min={field.lower} max={field.upper} step={field.step} value={field.value} disabled={!ready || pending} className="min-w-0 flex-1 py-3" onValueChange={value=>{if(Array.isArray(value))field.update(value);}} />
              <span className="w-20 shrink-0 text-right text-xs tabular-nums">{field.value[0]}–{field.value[1]} {field.unit}</span>
            </div>
          </Field>)}
        </fieldset>
      </ConfigPanelSection>
    {invalidRange && <p role="alert" className="text-xs text-destructive">请检查范围：最小值不能大于最大值；视频块 2–60 个，音频块 2–80 个，时长 6–60 秒</p>}
    {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-xs text-destructive">{error}</p>}
    </ConfigurationPageFrame>}
    </TabsContent>
  </Tabs>;
}
