import type { FeishuRunnerState } from "./task-types";

export type FeishuTaskService = ReturnType<typeof createFeishuTaskService>;
export function createFeishuTaskService(channel: string) {
  const invoke = (action: string): Promise<FeishuRunnerState> => {
    if (!window.ipcRenderer) return Promise.reject(new Error("表格任务仅在桌面应用内可用"));
    return window.ipcRenderer.invoke(`${channel}:${action}`) as Promise<FeishuRunnerState>;
  };
  return {
    workspace: () => invoke("workspace"),
    start: () => invoke("start"),
    pause: () => invoke("pause"),
    onChanged: (listener: () => void) => {
      const handler = () => listener();
      window.ipcRenderer?.on(`${channel}:changed`, handler);
      return () => {
        window.ipcRenderer?.off(`${channel}:changed`, handler);
      };
    },
  };
}
