import { app, dialog, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveFfmpegExecutablePath, resolveFfprobeExecutablePath } from "@dramabridge/media-assets";
import { runCompressionBatch, inspectCompressionVideo, validateCompressionTarget, type CompressionState } from "../../packages/video-separation/src/lossless-compression";
import { resolveGlobalPlatformDirectories } from "../global-app-config";
import { emitIpcEvent, trpcIpc as ipc } from "../ipc";

let controller: AbortController | undefined;
export function stopVideoCompression() { controller?.abort(); }

export function registerVideoCompressionHandlers() {
  let state: CompressionState = { status: "idle", items: [], message: "添加视频后开始压缩。" };
  let selecting = false;
  const tools = () => ({ ffmpeg: resolveFfmpegExecutablePath(), ffprobe: resolveFfprobeExecutablePath() });
  const publish = (patch: Partial<CompressionState>) => { state = { ...state, ...patch }; emitIpcEvent("video-compression:progress", state); };
  app.once("before-quit", stopVideoCompression);
  ipc.handle("video-compression:state", () => state);
  ipc.handle("video-compression:choose", async () => {
    if (controller || selecting) throw new Error("请先等待当前压缩任务完成或停止任务。");
    selecting = true;
    try {
      const selection = await dialog.showOpenDialog({ title: "选择要压缩的视频", properties: ["openFile", "multiSelections"],
        filters: [{ name: "视频", extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm", "wmv", "ts", "m2ts"] }] });
      if (selection.canceled || !selection.filePaths[0]) return state;
      const items = [...(state.items ?? [])];
      const key = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
      const existing = new Set(items.map(item => key(item.file)));
      for (const file of selection.filePaths) {
        if (existing.has(key(file))) continue;
        existing.add(key(file));
        try {
          const source = await inspectCompressionVideo(file, tools());
          items.push({ id: randomUUID(), file, name: source.name, source, status: "ready", message: "待压缩" });
        } catch (error) {
          items.push({ id: randomUUID(), file, name: path.basename(file), status: "failed", message: error instanceof Error ? error.message : "无法读取视频" });
        }
      }
      state = { status: "ready", items, message: `已添加 ${items.length} 个视频` };
      publish({}); return state;
    } finally { selecting = false; }
  });
  ipc.handle("video-compression:remove", (_event, id?: string) => {
    if (controller || selecting) throw new Error("请先停止当前任务。");
    if (id !== undefined && typeof id !== "string") throw new Error("无效的视频。");
    const items = id === undefined ? [] : (state.items ?? []).filter(item => item.id !== id);
    state = { status: items.length ? "ready" : "idle", items, message: items.length ? `共 ${items.length} 个视频` : "添加视频后开始压缩。" };
    publish({}); return state;
  });
  ipc.handle("video-compression:start", (_event, targetBytes: number, effort: "fast" | "smallest" | "balanced" = "balanced") => {
    if (controller || selecting) throw new Error("已有压缩任务正在进行。");
    validateCompressionTarget(targetBytes);
    if (effort !== "fast" && effort !== "smallest" && effort !== "balanced") throw new Error("请选择有效的压缩策略。");
    if (!state.items?.some(item => item.source)) throw new Error("请先添加可读取的视频。");
    const { runDataDir } = resolveGlobalPlatformDirectories("video-processing", {
      runDataDir: process.platform === "win32" ? "D:\\.drama-runs\\video-processing" : path.join(app.getPath("userData"), ".drama-runs", "video-processing"),
      localMaterialRoot: app.getPath("downloads"),
    });
    const relative = path.relative(app.getAppPath(), runDataDir);
    if (!path.isAbsolute(runDataDir) || relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("请在全局配置中将运行数据目录设到项目之外。");
    const now = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, "0");
    const folder = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const outputDirectory = path.join(runDataDir, effort === "balanced" ? "清晰压缩" : "无损压缩", folder);
    const items = state.items;
    const current = new AbortController(); controller = current;
    state = { status: "running", items, targetBytes, outputDirectory, effort, message: "正在准备视频压缩" }; publish({});
    void (async () => {
      try {
        const finished = await runCompressionBatch({ items, targetBytes, outputDirectory, tools: tools(), signal: current.signal, effort,
          onUpdate: updated => publish({ items: updated }) });
        const completed = finished.filter(item => item.status === "success").length;
        const failed = finished.filter(item => item.status === "failed").length;
        const unmet = finished.filter(item => item.status === "target-unmet").length;
        publish({ status: current.signal.aborted ? "cancelled" : failed ? "failed" : unmet ? "target-unmet" : "success", items: finished,
          message: current.signal.aborted ? `已停止，已完成 ${completed} 个` : `已完成 ${completed} 个${unmet ? `，未达标 ${unmet} 个` : ""}${failed ? `，失败 ${failed} 个` : ""}` });
      } catch (error) {
        publish({ status: current.signal.aborted ? "cancelled" : "failed", progress: undefined,
          message: current.signal.aborted ? "已停止压缩，原视频保留。" : error instanceof Error ? error.message : "压缩失败，请重试。" });
      } finally { if (controller === current) controller = undefined; }
    })();
    return state;
  });
  ipc.handle("video-compression:cancel", () => { controller?.abort(); });
  ipc.handle("video-compression:open-output", async () => {
    if (!state.outputDirectory) throw new Error("暂未生成结果。");
    const error = await shell.openPath(state.outputDirectory);
    if (error) throw new Error("结果目录暂不可用，请等待任务开始后重试。");
  });
}
