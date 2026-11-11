export type AccountSyncState = {
  running: boolean; stopping: boolean; message: string; error?: string;
  completed: number; failed: number; current?: string; accountId?: string; accountIds?: string[]; currentAccountName?: string;
};
async function invoke<T>(action: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("账号同步仅在桌面应用内可用");
  return window.ipcRenderer.invoke(`kuaishou-drama:account-sync:${action}`, ...args) as Promise<T>;
}
export const kuaishouAccountSyncService = {
  status: () => invoke<AccountSyncState>("status"),
  start: (accountIds: string[]) => invoke<AccountSyncState>("start", accountIds),
  stop: () => invoke<AccountSyncState>("stop"),
};
