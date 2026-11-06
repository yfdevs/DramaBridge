export type DirectoryListing = {directory:string; parent:string; entries:{name:string;directory:boolean;path:string}[]};
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try { return await window.ipcRenderer.invoke(channel, ...args); }
  catch (error) {
    if (String(error).includes('未注册 IPC 过程')) throw new Error('视频分离主进程尚未更新，请完全退出应用后重新启动；开发环境请重启 pnpm dev。');
    throw error;
  }
}
export const videoSeparation = {
  browse: (directory?: string): Promise<DirectoryListing> => invoke('video-separation:browse', directory),
  choose: (): Promise<string | null> => invoke('video-separation:choose'),
  scan: (directory: string): Promise<{directory: string; count: number}> => invoke('video-separation:scan', directory),
  run: (directory: string, seconds: number, taskId: string): Promise<{output: string; count: number}> => invoke('video-separation:run', directory, seconds, taskId),
  pause: (value: boolean) => invoke('video-separation:pause', value),
  subscribe: (callback: (value: {id: string; message: string}) => void) => {
    const listener = (_event: unknown, value: {id: string; message: string}) => callback(value);
    window.ipcRenderer.on('video-separation:progress', listener);
    return () => { window.ipcRenderer.off('video-separation:progress', listener); };
  },
  open: (directory: string) => invoke('video-separation:open', directory),
};
