import type { IpcRendererEvent } from "electron";
import type {
  WeixinChannelsSettings,
  WeixinChannelsSyncEvent,
  WeixinChannelsSyncMode,
} from "@dramabridge/wechat-drama-automation";
export type { WeixinChannelsSettings, WeixinChannelsSyncEvent, WeixinChannelsSyncMode };
export type DataSyncState = {
  settings: WeixinChannelsSettings;
  records: WeixinChannelsSyncEvent[];
  runningModes: WeixinChannelsSyncMode[];
  dryRun: boolean;
  lastEvent?: WeixinChannelsSyncEvent;
};
async function invoke<T>(action: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("数据同步仅在桌面应用内可用");
  return window.ipcRenderer.invoke(`wechat-drama:data-sync:${action}`, ...args) as Promise<T>;
}
export const wechatDataSyncService = {
  state: () => invoke<DataSyncState>("state"),
  start: (mode: WeixinChannelsSyncMode) =>
    invoke<{ mode: WeixinChannelsSyncMode; started: boolean; running: boolean }>("start", mode),
  stop: (mode: WeixinChannelsSyncMode) => invoke("stop", mode),
  saveSettings: (settings: WeixinChannelsSettings) =>
    invoke<WeixinChannelsSettings>("settings", settings),
  clearRecords: () => invoke("clear-records"),
  openDirectory: () => invoke("open-directory"),
  onEvent(listener: (event: WeixinChannelsSyncEvent) => void) {
    if (!window.ipcRenderer) return () => undefined;
    const handler = (_event: IpcRendererEvent, payload: WeixinChannelsSyncEvent) =>
      listener(payload);
    window.ipcRenderer.on("wechat-drama:data-sync:event", handler);
    return () => window.ipcRenderer.off("wechat-drama:data-sync:event", handler);
  },
};
