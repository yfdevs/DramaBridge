import { app, clipboard, dialog, shell } from "electron";
import path from "node:path";
import { copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { findTranscriptionRuntime, transcribeVideo, type TranscriptionState } from "../../../packages/jianying/src/transcription";
import { scanTranscriptionEpisodes, selectTranscriptionEpisodes, transcribeEpisodes, type BatchTranscriptionState, type EpisodeSelection } from "../../../packages/jianying/src/batch-transcription";
import { emitIpcEvent, trpcIpc as ipc } from "../../ipc";
import { resolveGlobalPlatformDirectories } from "../../global-app-config";

let controller: AbortController | undefined;
export function stopJianyingTranscription() { controller?.abort(); }

export function registerJianyingTranscription(getExecutable: () => string) {
  let state: TranscriptionState = { status: "idle", message: "选择一个视频，识别其中的语音并生成文字。" };
  let selecting = false;
  let fullText = "";
  let batch: BatchTranscriptionState = { status: "idle", message: "选择剧集目录，自动读取视频和集数。", items: [] };
  function updateBatch(patch: Partial<BatchTranscriptionState>) {
    batch = { ...batch, ...patch };
    emitIpcEvent("jianying:transcription:batch-progress", batch);
  }
  function requireIdle() {
    if (controller || selecting) throw new Error("字幕识别正在进行，请等待完成或先停止。");
    if (process.platform !== "win32") throw new Error("剪映接口识别目前仅支持 Windows。");
  }
  function runtime() {
    const apps = path.join(path.dirname(app.getPath("appData")), "Local", "JianyingPro", "Apps");
    return findTranscriptionRuntime(apps, getExecutable());
  }
  function transcriptRoot() {
    const { runDataDir } = resolveGlobalPlatformDirectories("jianying", {
      runDataDir: process.platform === "win32" ? "D:\\.drama-runs\\jianying" : path.join(app.getPath("userData"), ".drama-runs", "jianying"),
      localMaterialRoot: app.getPath("downloads"),
    });
    const relativeToApp = path.relative(app.getAppPath(), runDataDir);
    if (!path.isAbsolute(runDataDir) || relativeToApp === "" || (!relativeToApp.startsWith(`..${path.sep}`) && relativeToApp !== ".." && !path.isAbsolute(relativeToApp))) {
      throw new Error("请在“全局配置 → 文件存储”中将运行数据目录设置到项目目录之外。");
    }
    return path.join(runDataDir, "字幕");
  }
  function update(patch: Partial<TranscriptionState>) {
    state = { ...state, ...patch };
    emitIpcEvent("jianying:transcription:progress", state);
  }
  ipc.handle("jianying:transcription:state", () => state);
  ipc.handle("jianying:transcription:batch-state", () => batch);
  ipc.handle("jianying:transcription:choose-directory", async () => {
    requireIdle(); selecting = true;
    try {
      const selected = await dialog.showOpenDialog({ title: "选择包含剧集视频的目录", properties: ["openDirectory"] });
      if (selected.canceled || !selected.filePaths[0]) return batch;
      const directory = selected.filePaths[0];
      const items = await scanTranscriptionEpisodes(directory);
      batch = { status: "ready", directory, items, message: `找到 ${items.length} 个视频，默认全部识别；可修改集数编号或勾选范围。` };
      updateBatch({}); return batch;
    } finally { selecting = false; }
  });
  ipc.handle("jianying:transcription:start-batch", (_event, selections: EpisodeSelection[]) => {
    requireIdle();
    if (!batch.directory) throw new Error("请先选择剧集目录。");
    const items = selectTranscriptionEpisodes(batch.items, selections);
    const output = path.join(transcriptRoot(), `多集-${randomUUID()}`);
    const current = new AbortController(); controller = current;
    batch = { status: "running", directory: batch.directory, output, items, message: "正在查找剪映识别组件" };
    updateBatch({});
    void (async () => {
      try {
        const selectedRuntime = await runtime();
        const result = await transcribeEpisodes({ items, output, runtime: selectedRuntime, signal: current.signal,
          onProgress: (items, message) => updateBatch({ items, message }) });
        updateBatch(result);
      } catch (error) {
        updateBatch({ status: current.signal.aborted ? "cancelled" : "failed",
          message: current.signal.aborted ? "已停止识别。" : error instanceof Error ? error.message : "多集识别失败，请重试。" });
      } finally { if (controller === current) controller = undefined; }
    })();
    return batch;
  });
  ipc.handle("jianying:transcription:batch-open-output", async () => {
    if (!batch.output) throw new Error("请先开始识别。");
    const error = await shell.openPath(batch.output);
    if (error) throw new Error("无法打开结果目录，请检查文件是否仍然存在。");
  });
  ipc.handle("jianying:transcription:batch-reveal", (_event, id: string) => {
    const item = batch.items.find(item => item.id === id);
    if (item?.status !== "success" || !item.subtitlePath) throw new Error("这一集暂未生成字幕。");
    shell.showItemInFolder(item.subtitlePath);
  });
  ipc.handle("jianying:transcription:choose-and-start", async () => {
    requireIdle();
    selecting = true;
    try {
      const selected = await dialog.showOpenDialog({
        title: "选择要识别的视频", properties: ["openFile"],
        filters: [{ name: "视频文件", extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm", "wmv", "flv", "ts", "mts", "m2ts"] }],
      });
      if (selected.canceled || !selected.filePaths[0]) return state;
      const source = selected.filePaths[0];
      const current = new AbortController();
      controller = current;
      fullText = "";
      state = { status: "running", source, message: "正在查找剪映识别组件" };
      update({});
      void (async () => {
        try {
          const selectedRuntime = await runtime();
          current.signal.throwIfAborted();
          const result = await transcribeVideo({
            source, runtime: selectedRuntime, signal: current.signal,
            outputRoot: transcriptRoot(),
            onProgress: message => update({ message }),
          });
          fullText = result.text;
          update({ ...result, text: result.text.slice(0, 100_000), status: "success",
            message: result.sentenceCount ? `识别完成，共 ${result.sentenceCount} 段，已保存 TXT 和 SRT。` : "识别完成，未检测到语音，已保存空文本。" });
        } catch (error) {
          update({ status: current.signal.aborted ? "cancelled" : "failed",
            message: current.signal.aborted ? "已停止识别，可以重新选择视频。" : error instanceof Error ? error.message : "识别失败，请重试。" });
        } finally { if (controller === current) controller = undefined; }
      })();
      return state;
    } finally { selecting = false; }
  });
  ipc.handle("jianying:transcription:cancel", () => { controller?.abort(); });
  ipc.handle("jianying:transcription:copy", () => {
    if (state.status !== "success" || !fullText) throw new Error("暂时没有可复制的文字。");
    clipboard.writeText(fullText);
  });
  ipc.handle("jianying:transcription:save", async (_event, format: "txt" | "srt") => {
    if (format !== "txt" && format !== "srt") throw new Error("不支持的导出格式。");
    const source = format === "txt" ? state.textPath : state.subtitlePath;
    if (state.status !== "success" || !source) throw new Error("请先完成识别。");
    const selected = await dialog.showSaveDialog({
      title: format === "txt" ? "保存识别文字" : "保存字幕文件",
      defaultPath: path.join(app.getPath("documents"), path.basename(source)),
      filters: [{ name: format === "txt" ? "文本文件" : "SRT 字幕", extensions: [format] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    if (path.resolve(selected.filePath) !== path.resolve(source)) await copyFile(source, selected.filePath);
    return selected.filePath;
  });
  ipc.handle("jianying:transcription:open-output", async () => {
    if (state.status !== "success" || !state.output) throw new Error("暂未生成结果。");
    const error = await shell.openPath(state.output);
    if (error) throw new Error("无法打开结果目录，请检查文件是否仍然存在。");
  });
}
