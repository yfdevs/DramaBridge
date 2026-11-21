import type { JianyingTask, JianyingQueueState } from "../../../packages/jianying/src/task-queue";
export type { JianyingTask, JianyingQueueState };
import type { TranscriptionState } from "../../../packages/jianying/src/transcription";
export type { TranscriptionState };
import type { BatchTranscriptionState, EpisodeSelection, TranscriptionEpisode } from "../../../packages/jianying/src/batch-transcription";
export type { BatchTranscriptionState, EpisodeSelection, TranscriptionEpisode };
export type JianyingState = { status: "idle" | "running" | "success" | "failed" | "cancelled"; message: string; logs: string[]; output?: string; screenshot?: string; screenshots?: string[] };
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("剪映工具需要在桌面应用中使用");
  return window.ipcRenderer.invoke(channel, ...args);
}
export const jianying = {
  batchTranscriptionState: () => invoke<BatchTranscriptionState>("jianying:transcription:batch-state"),
  chooseTranscriptionDirectory: () => invoke<BatchTranscriptionState>("jianying:transcription:choose-directory"),
  transcribeBatch: (items: EpisodeSelection[]) => invoke<BatchTranscriptionState>("jianying:transcription:start-batch", items),
  openBatchTranscriptOutput: () => invoke<void>("jianying:transcription:batch-open-output"),
  revealEpisodeSubtitle: (id: string) => invoke<void>("jianying:transcription:batch-reveal", id),
  subscribeBatchTranscription: (callback: (value: BatchTranscriptionState) => void) => {
    if (!window.ipcRenderer) return () => undefined;
    const listener = (_event: unknown, value: BatchTranscriptionState) => callback(value);
    window.ipcRenderer.on("jianying:transcription:batch-progress", listener);
    return () => { window.ipcRenderer.off("jianying:transcription:batch-progress", listener); };
  },
  transcriptionState: () => invoke<TranscriptionState>("jianying:transcription:state"),
  transcribe: () => invoke<TranscriptionState>("jianying:transcription:choose-and-start"),
  cancelTranscription: () => invoke<void>("jianying:transcription:cancel"),
  copyTranscript: () => invoke<void>("jianying:transcription:copy"),
  saveTranscript: (format: "txt" | "srt") => invoke<string | null>("jianying:transcription:save", format),
  openTranscriptOutput: () => invoke<void>("jianying:transcription:open-output"),
  subscribeTranscription: (callback: (value: TranscriptionState) => void) => {
    if (!window.ipcRenderer) return () => undefined;
    const listener = (_event: unknown, value: TranscriptionState) => callback(value);
    window.ipcRenderer.on("jianying:transcription:progress", listener);
    return () => { window.ipcRenderer.off("jianying:transcription:progress", listener); };
  },
  queueState: () => invoke<JianyingQueueState>("jianying:queue-state"),
  addTask: (source: string, min: number, max: number, ranges: WorkbenchRanges) => invoke<JianyingQueueState>("jianying:queue-add",source,min,max,ranges),
  startQueue: () => invoke<JianyingQueueState>("jianying:queue-start"),
  pauseQueue: () => invoke<JianyingQueueState>("jianying:queue-pause"),
  removeTask: (id: string) => invoke<JianyingQueueState>("jianying:queue-remove",id),
  retryTask: (id: string) => invoke<JianyingQueueState>("jianying:queue-retry",id),
  openTaskOutput: (id: string) => invoke<void>("jianying:queue-open-output",id),
  subscribeQueue: (callback: (value: JianyingQueueState) => void) => {
    if (!window.ipcRenderer) return () => undefined;
    const listener = (_event: unknown, value: JianyingQueueState) => callback(value);
    window.ipcRenderer.on("jianying:queue-progress", listener);
    return () => { window.ipcRenderer.off("jianying:queue-progress",listener); };
  },
  saveSettings: (min: number, max: number, ranges: WorkbenchRanges) => invoke<void>("jianying:save-settings",min,max,ranges),
  settings: () => invoke<{ executable: string; minSeconds: number; maxSeconds: number } & WorkbenchRanges>("jianying:settings"),
  state: () => invoke<JianyingState>("jianying:state"),
  chooseExecutable: () => invoke<string | null>("jianying:choose-executable"),
  launch: () => invoke<{ executable: string }>("jianying:launch"),
  chooseSource: () => invoke<string | null>("jianying:choose-source"),
  start: (source: string, min: number, max: number, ranges: WorkbenchRanges) => invoke<JianyingState>("jianying:start", source, min, max, ranges),
  cancel: () => invoke<void>("jianying:cancel"),
  openOutput: (screenshot = false) => invoke<void>("jianying:open-output", screenshot),
  subscribe: (callback: (value: JianyingState) => void) => {
    if (!window.ipcRenderer) return () => undefined;
    const listener = (_event: unknown, value: JianyingState) => callback(value);
    window.ipcRenderer.on("jianying:progress", listener);
    return () => { window.ipcRenderer.off("jianying:progress", listener); };
  },
};
import { DEFAULT_WORKBENCH_RANGES, type WorkbenchRanges } from "../../../packages/jianying/src/workbench-settings";
export { DEFAULT_WORKBENCH_RANGES, type WorkbenchRanges };
