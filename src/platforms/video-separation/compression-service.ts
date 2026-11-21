import type { CompressionState } from "../../../packages/video-separation/src/lossless-compression";
export type { CompressionState };

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("视频压缩需要在桌面应用中使用。");
  return window.ipcRenderer.invoke(channel, ...args);
}
export const videoCompression = {
  state: () => invoke<CompressionState>("video-compression:state"),
  choose: () => invoke<CompressionState>("video-compression:choose"),
  remove: (id?: string) => invoke<CompressionState>("video-compression:remove", id),
  start: (targetBytes: number, effort: "fast" | "smallest" | "balanced" = "balanced") => invoke<CompressionState>("video-compression:start", targetBytes, effort),
  cancel: () => invoke<void>("video-compression:cancel"),
  openOutput: () => invoke<void>("video-compression:open-output"),
  subscribe: (callback: (state: CompressionState) => void) => {
    if (!window.ipcRenderer) return () => undefined;
    const listener = (_event: unknown, state: CompressionState) => callback(state);
    window.ipcRenderer.on("video-compression:progress", listener);
    return () => { window.ipcRenderer.off("video-compression:progress", listener); };
  },
};
