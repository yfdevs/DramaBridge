import { emitIpcEvent, trpcIpc as ipcMain } from "../../ipc";
import { openAutomationDatabase } from "../../storage/database";
import { KuaishouFeishuRepository } from "../../storage/kuaishou-feishu";
import {
  configuredFeishuTables,
  lockFeishuSettings,
  readFeishuSettings,
} from "../../integrations/feishu";
import { transferKuaishouRecreationBundle } from "./recreation-bundle";
import { KuaishouFeishuRunner } from "./recreation-feishu";

let runner: KuaishouFeishuRunner | undefined;
let stopping: Promise<void> | undefined;
export async function stopKuaishouRecreation() {
  if (stopping) return stopping;
  stopping = (async () => {
    try {
      await runner?.stop();
    } finally {
      lockFeishuSettings("kuaishou-recreation", false);
    }
  })();
  try {
    await stopping;
  } finally {
    stopping = undefined;
  }
}
export function registerKuaishouRecreationHandlers(
  readConfig: () => { recreationSheetName: string; recreationPollSeconds: string },
) {
  let notification: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (notification) return;
    notification = setTimeout(() => {
      notification = undefined;
      emitIpcEvent("kuaishou-drama:recreation:changed");
    }, 150);
  };
  const workspace = () =>
    runner?.status() ?? {
      running: false,
      stopping: false,
      phase: "idle",
      message: "点击开始处理，读取飞书中的待处理剧目",
      completed: 0,
      failed: 0,
    };
  ipcMain.handle("kuaishou-drama:recreation:workspace", workspace);
  ipcMain.handle("kuaishou-drama:recreation:start", () => {
    if (stopping) throw new Error("正在停止，请等待当前剧目完成");
    if (runner?.status().running) return workspace();
    const settings = readFeishuSettings();
    const tables = configuredFeishuTables();
    const config = readConfig();
    runner = new KuaishouFeishuRunner({
      tables,
      url: settings.tableUrl,
      sheet: config.recreationSheetName,
      pollSeconds: Number(config.recreationPollSeconds),
      journal: new KuaishouFeishuRepository(openAutomationDatabase().database),
      singleBundle: true,
      plainLink: true,
      transfer: transferKuaishouRecreationBundle,
      changed: notify,
    });
    lockFeishuSettings("kuaishou-recreation", true);
    runner.start();
    return workspace();
  });
  ipcMain.handle("kuaishou-drama:recreation:pause", async () => {
    await stopKuaishouRecreation();
    return workspace();
  });
}
