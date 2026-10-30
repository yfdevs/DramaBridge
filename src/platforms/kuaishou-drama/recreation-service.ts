import type { RecreationWorkspace } from "./recreation-types";

async function invoke<T>(action: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("二创任务仅在桌面应用内可用");
  return window.ipcRenderer.invoke(`kuaishou-drama:recreation:${action}`, ...args) as Promise<T>;
}
export const kuaishouRecreationService = {
  onChanged: (listener: () => void) => {
    const handler = () => listener();
    window.ipcRenderer?.on("kuaishou-drama:recreation:changed", handler);
    return () => { window.ipcRenderer?.off("kuaishou-drama:recreation:changed", handler); };
  },
  workspace: () => invoke<RecreationWorkspace>("workspace"),
  template: () => invoke<boolean>("template"),
  importExcel: () => invoke<{ count: number; workspace: RecreationWorkspace }>("import"),
  start: () => invoke<RecreationWorkspace>("start"),
  pause: () => invoke<RecreationWorkspace>("pause"),
  cancel: () => invoke<RecreationWorkspace>("cancel"),
  retry: (id: string) => invoke<RecreationWorkspace>("retry", id),
  delete: (id: string) => invoke<RecreationWorkspace>("delete", id),
  open: (id: string) => invoke<string>("open", id),
};
