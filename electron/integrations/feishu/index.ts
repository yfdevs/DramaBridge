import { safeStorage } from "electron";
import { FeishuClient, FeishuTables } from "@dramabridge/feishu";
import { createValidatedStore } from "../../core/config-store";
import { trpcIpc as ipcMain } from "../../ipc";
import type { FeishuSettings, FeishuSettingsInput } from "../../../src/platforms/feishu/service";

let store: ReturnType<typeof createStore> | undefined;
const createStore = () =>
  createValidatedStore({
    name: "feishu-tables",
    defaults: {
      appId: "",
      secretCiphertext: "",
      tableUrl: "",
    },
  });
const configStore = () => (store ??= createStore());
const users = new Set<string>();
export function lockFeishuSettings(owner: string, locked: boolean) {
  if (locked) users.add(owner);
  else users.delete(owner);
}
export function readFeishuSettings(): FeishuSettings {
  const value = configStore().store;
  return { appId: value.appId, hasSecret: !!value.secretCiphertext, tableUrl: value.tableUrl };
}
export function configuredFeishuTables() {
  const stored = configStore().store;
  if (!stored.appId || !stored.secretCiphertext)
    throw new Error("请先在全局配置 → 飞书表格中保存 App ID 和 App Secret");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法读取飞书凭证");
  const appSecret = safeStorage.decryptString(Buffer.from(stored.secretCiphertext, "base64"));
  return new FeishuTables(new FeishuClient({ appId: stored.appId, appSecret }));
}
export function registerFeishuTableHandlers() {
  ipcMain.handle("feishu:tables:settings", readFeishuSettings);
  ipcMain.handle("feishu:tables:save", (_event, input: FeishuSettingsInput) => {
    if (users.size) throw new Error("请先停止各平台的表格任务，再修改飞书连接");
    if (!input || typeof input.appId !== "string" || !/^cli_[a-zA-Z0-9]+$/.test(input.appId.trim()))
      throw new Error("App ID 无效");
    const url = new URL(input.tableUrl);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".feishu.cn") ||
      !/^\/(wiki|sheets)\/[A-Za-z0-9]+/.test(url.pathname)
    )
      throw new Error("请填写飞书电子表格或知识库链接");
    const settings = configStore();
    let secretCiphertext = settings.get("secretCiphertext");
    if (input.appSecret) {
      if (typeof input.appSecret !== "string" || !safeStorage.isEncryptionAvailable())
        throw new Error("系统安全存储不可用，无法保存飞书凭证");
      secretCiphertext = safeStorage.encryptString(input.appSecret.trim()).toString("base64");
    } else if (input.appId.trim() !== settings.get("appId"))
      throw new Error("更换应用时请同时填写新的 App Secret");
    settings.store = { appId: input.appId.trim(), secretCiphertext, tableUrl: url.toString() };
    return readFeishuSettings();
  });
  ipcMain.handle("feishu:tables:test", async () => {
    const settings = readFeishuSettings();
    const sheets = await configuredFeishuTables().list(settings.tableUrl);
    return { sheets: sheets.map((sheet) => sheet.title) };
  });
}
