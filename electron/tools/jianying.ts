import { JianyingTaskQueue, type JianyingTask } from "../../packages/jianying/src/task-queue";
import { app, dialog, shell } from "electron";
import Store from "electron-store";
import path from "node:path";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { planDramaWorkflow, prepareDramaMaterials, prepareDesktopPython, runDesktopWorkflow, firstEpisodeWorkbench, DEFAULT_WORKBENCH_RANGES, validateWorkbenchRanges, type WorkbenchRanges } from "@dramabridge/jianying";
import { scanEpisodes } from "@dramabridge/video-separation";
import { emitIpcEvent, trpcIpc as ipc } from "../ipc";
import { registerJianyingTranscription, stopJianyingTranscription } from "../platforms/jianying/transcription";

let controller: AbortController | undefined;
export function stopJianyingProcessing() { controller?.abort(); stopJianyingTranscription(); }
type State = { status: "idle" | "running" | "success" | "failed" | "cancelled"; message: string; logs: string[]; output?: string; screenshot?: string; screenshots?: string[] };
export function registerJianyingHandlers() {
  const store = new Store<{ executable: string; minSeconds: number; maxSeconds: number } & WorkbenchRanges>({ name: "jianying-workflow", defaults: { executable: "", minSeconds: 15, maxSeconds: 30, ...DEFAULT_WORKBENCH_RANGES } });
  registerJianyingTranscription(() => store.get("executable"));
  if (store.get("videoBlocksMin") === 12 && store.get("videoBlocksMax") === 24) {
    store.set({ videoBlocksMin: 8, videoBlocksMax: 14 });
  }
  let state: State = { status: "idle", message: "选择包含第 1–4 集的剧集目录，即可启动全流程处理。", logs: [] };
  const queueStore = new Store<{ tasks: JianyingTask[] }>({ name: "jianying-task-queue", defaults: {tasks:[]} });
  let activeTaskId: string | undefined;
  const queue = new JianyingTaskQueue(queueStore.get("tasks"), async task => {
    idle(); activeTaskId=task.id;
    try {
      await run(task.source, task.settings.minSeconds, task.settings.maxSeconds, task.settings);
      if (state.status!=="success") {
        const error=new Error(state.message); if (state.status==="cancelled") error.name="AbortError"; throw error;
      }
    } finally { activeTaskId=undefined; }
  }, snapshot => { queueStore.set("tasks",snapshot.tasks); emitIpcEvent("jianying:queue-progress",snapshot); });
  function publish(message: string) {
    if (activeTaskId) queue.update(activeTaskId,{message,output:state.output,screenshots:state.screenshots}); state = { ...state, message, logs: [...state.logs, message].slice(-100) }; emitIpcEvent("jianying:progress", state); }
  function idle() { if (controller) throw new Error("任务正在进行，请先等待完成或停止"); }
  async function launch() {
    if (process.platform !== "win32") throw new Error("剪映自动化仅支持 Windows");
    const executable = store.get("executable") || path.join(path.dirname(app.getPath("appData")), "Local/JianyingPro/Apps/JianyingPro.exe");
    if (!(await stat(executable).catch(() => null))?.isFile()) throw new Error("未找到剪映，请选择剪映主程序");
    const error = await shell.openPath(executable); if (error) throw new Error(error);
    return { executable };
  }
  ipc.handle("jianying:settings", () => store.store);
  ipc.handle("jianying:save-settings", (_event, minSeconds: number, maxSeconds: number, ranges: WorkbenchRanges) => {
    if (!Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds) || minSeconds<6 || maxSeconds>60 || minSeconds>maxSeconds) throw new Error("素材时长须在 6–60 秒之间");
    store.set({minSeconds,maxSeconds,...validateWorkbenchRanges(ranges)});
  });
  ipc.handle("jianying:state", () => state);
  ipc.handle("jianying:launch", launch);
  ipc.handle("jianying:choose-executable", async () => {
    idle(); const selected = await dialog.showOpenDialog({ title: "选择 JianyingPro.exe", properties: ["openFile"], filters: [{ name: "剪映", extensions: ["exe"] }] });
    if (selected.canceled) return null;
    const executable = selected.filePaths[0];
    if (path.basename(executable).toLowerCase() !== "jianyingpro.exe") throw new Error("请选择 JianyingPro.exe");
    store.set("executable", executable); return executable;
  });
  ipc.handle("jianying:choose-source", async () => {
    const selected = await dialog.showOpenDialog({ title: "选择剧集视频目录", properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0];
  });
  async function run(source: string, minSeconds: number, maxSeconds: number, ranges?: WorkbenchRanges) {
    idle();
    const selectedRanges = validateWorkbenchRanges(ranges ?? store.store);
    const current = new AbortController(); controller = current;
    state = { status: "running", message: "正在检查剧集目录", logs: [] }; publish(state.message);
    await (async () => {
      let manifestPath: string | undefined;
      try {
        if (!path.isAbsolute(source) || !(await stat(source)).isDirectory()) throw new Error("请选择有效的视频目录");
        const episodes = await scanEpisodes(source);
        const plan = await planDramaWorkflow(episodes.map(item => ({ episode: item.index, source: item.path })), { minSeconds, maxSeconds });
        publish(`本次处理：${plan.episodes.map(item=>`第 ${item.episode} 集`).join("、")}`);
        current.signal.throwIfAborted();
        publish("正在准备剪映桌面执行环境");
        const python = await prepareDesktopPython(path.join(app.getPath("userData"), "jianying-runtime"), current.signal, publish);
        publish("正在启动剪映"); await launch();
        publish("正在并发分割第 1–4 集素材（仅准备一次）");
        const materials = await prepareDramaMaterials(plan, source, { signal: current.signal, onProgress: publish });
        state.output = materials.output; manifestPath = materials.manifestPath;
        const script = app.isPackaged ? path.join(process.resourcesPath, "jianying-automation/desktop.py") : path.join(app.getAppPath(), "packages/jianying/python/desktop.py");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const completed = [];
        const screenshots: string[] = [];
        for (const episode of plan.episodes) {
          current.signal.throwIfAborted();
          const timeline = firstEpisodeWorkbench(episode.duration,undefined,selectedRanges);
          const episodeOutput = path.join(materials.output, `第${String(episode.episode).padStart(2,"0")}集`);
          await mkdir(episodeOutput,{recursive:true});
          const request = path.join(episodeOutput,"桌面执行请求.json");
          publish(`第 ${episode.episode}/4 集：视频块 ${timeline.overlays.length} 个，音频块 ${timeline.audio.length+timeline.audioCopies.length} 个，准备独立草稿`);
          await writeFile(request,JSON.stringify({...timeline,action:"run",episode:episode.episode,
            source:episode.source,fragments:materials.fragments.flatMap(item=>item.files),
            duration:episode.duration,cutSeconds:timeline.base.slice(1).map(clip=>clip.start),
            screenshotCount:timeline.screenshotCount,output:episodeOutput,
            screenshotDirectory:path.join(materials.output,"截图",`第${String(episode.episode).padStart(2,"0")}集`),
            screenshot:path.join(episodeOutput,"截图","剪映处理截图-01.png")}));
          const result = await runDesktopWorkflow(python,script,request,current.signal,message=>publish(`第 ${episode.episode}/4 集 · ${message}`));
          completed.push({episode:episode.episode,output:episodeOutput,timeline,result,nativeStages:{
            importedToMaterialPanel:true,originalEpisodeAddedToTimeline:true,audioDetachedInJianying:true,
            videoSplitInJianying:true,audioSplitInJianying:true,videoOverlaysCopied:true,
            audioRepeatedAndOverlapped:true,subtitlesRecognized:result.subtitleSegmentsVisible>0,
            effectsAdded:result.effectsAdded>0,screenshotSaved:result.screenshots.length===4,
          }});
          screenshots.push(...result.screenshots);
          state = {...state,screenshot:screenshots[0],screenshots:[...screenshots]};
          await writeFile(manifestPath,JSON.stringify({...manifest,status:"processing",nativeStages:{allEpisodesProcessed:false},completedEpisodes:completed},null,2));
          publish(`第 ${episode.episode} 集完成：视频 ${result.videoClips} 块 / ${result.videoTracks} 轨，音频 ${result.audioClips} 块 / ${result.audioTracks} 轨，截图 ${result.screenshots.length} 张。${result.warnings.join("；")}`);
        }
        await writeFile(manifestPath,JSON.stringify({...manifest,status:"success",nativeStages:{allEpisodesProcessed:true},completedEpisodes:completed},null,2));
        state = {...state,status:"success",screenshot:screenshots[0],screenshots};
        publish(`第 1–4 集全部完成，生成 4 个独立草稿，共保存 ${screenshots.length} 张截图。`);
      } catch (error) {
        state.status = current.signal.aborted ? "cancelled" : "failed";
        publish(current.signal.aborted ? "已停止，已生成的素材和草稿保留。" : String(error));
        if (manifestPath) {
          try { const manifest = JSON.parse(await readFile(manifestPath, "utf8")); await writeFile(manifestPath, JSON.stringify({ ...manifest, status: state.status, error: state.message }, null, 2)); } catch { /* Keep original failure. */ }
        }
      } finally { controller = undefined; }
    })();
    return state;
  }
  ipc.handle("jianying:start", (_event, source: string, min: number, max: number, ranges?: WorkbenchRanges) => {
    idle();
    if (queue.snapshot().running) throw new Error("请先暂停任务队列");
    void run(source,min,max,ranges).catch(error => { state.status="failed"; publish(String(error)); }); return state;
  });
  ipc.handle("jianying:queue-state", () => queue.snapshot());
  ipc.handle("jianying:queue-add", async (_event, source: string, minSeconds: number, maxSeconds: number, ranges: WorkbenchRanges) => {
    if (!Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds) || minSeconds<6 || maxSeconds>60 || minSeconds>maxSeconds) throw new Error("素材时长须在 6–60 秒之间");
    const selectedRanges=validateWorkbenchRanges(ranges);
    const absolute=path.resolve(source);
    if (!path.isAbsolute(source) || !(await stat(absolute)).isDirectory()) throw new Error("请选择有效的视频文件夹");
    const episodes=await scanEpisodes(absolute);
    for (const episode of [1,2,3,4]) if (episodes.filter(item=>item.index===episode).length!==1) throw new Error(`目录需要包含唯一的第 ${episode} 集视频`);
    return queue.add(absolute,path.basename(absolute),{minSeconds,maxSeconds,...selectedRanges});
  });
  ipc.handle("jianying:queue-start", () => { idle(); return queue.start(); });
  ipc.handle("jianying:queue-pause", () => queue.pause());
  ipc.handle("jianying:queue-remove", (_event,id: string) => queue.remove(id));
  ipc.handle("jianying:queue-retry", (_event,id: string) => queue.retry(id));
  ipc.handle("jianying:queue-open-output", async (_event,id: string) => {
    const task=queue.snapshot().tasks.find(task=>task.id===id);
    if (!task?.output) throw new Error("暂未生成结果");
    const error=await shell.openPath(task.output); if (error) throw new Error(error);
  });
  ipc.handle("jianying:cancel", () => { queue.pause(); controller?.abort(); });
  ipc.handle("jianying:open-output", async (_event, screenshot: boolean) => {
    const target = state.output && (screenshot ? path.join(state.output,"截图") : state.output);
    if (!target) throw new Error("暂未生成结果");
    const error = await shell.openPath(target); if (error) throw new Error(error);
  });
}
