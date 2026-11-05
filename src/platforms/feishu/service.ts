export type FeishuSettings = { appId: string; hasSecret: boolean; tableUrl: string };
export type FeishuSettingsInput = Omit<FeishuSettings, "hasSecret"> & { appSecret?: string };
async function invoke<T>(action: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error("飞书管理仅在桌面应用中可用");
  return window.ipcRenderer.invoke(`feishu:tables:${action}`, ...args) as Promise<T>;
}
export const feishuService = {
  settings: () => invoke<FeishuSettings>("settings"),
  save: (input: FeishuSettingsInput) => invoke<FeishuSettings>("save", input),
  test: () => invoke<{ sheets: string[] }>("test"),
};
