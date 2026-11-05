import { emitIpcEvent, trpcIpc } from "../../ipc";
import { openAutomationDatabase } from "../../storage/database";
import { FeishuTaskRepository } from "../../storage/feishu-tasks";
import { configuredFeishuTables, lockFeishuSettings, readFeishuSettings } from "./index";
import { FeishuTaskRunner, type FeishuTaskTransfer, type TaskTableOptions } from "./task-runner";

export function normalizeFeishuPollSeconds(value: string | undefined) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600 ? String(seconds) : "30";
}

export function registerFeishuTaskHandlers(
  options: TaskTableOptions & {
    platform: string;
    channel: string;
    readConfig: () => { sheetName: string; pollSeconds: string };
    transfer: FeishuTaskTransfer;
  },
) {
  let runner: FeishuTaskRunner | undefined;
  let stopping: Promise<void> | undefined;
  let database: ReturnType<typeof openAutomationDatabase>["database"] | undefined;
  let notification: ReturnType<typeof setTimeout> | undefined;
  const owner = `${options.platform}:feishu-tasks`;
  const workspace = () =>
    runner?.status() ?? {
      running: false,
      stopping: false,
      phase: "idle",
      message: "",
      completed: 0,
      failed: 0,
    };
  const stop = async () => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await runner?.stop();
      } finally {
        lockFeishuSettings(owner, false);
      }
    })();
    try {
      await stopping;
    } finally {
      stopping = undefined;
    }
  };
  trpcIpc.handle(`${options.channel}:workspace`, workspace);
  trpcIpc.handle(`${options.channel}:start`, () => {
    if (stopping) throw new Error("正在停止，请等待当前剧目完成");
    if (runner?.status().running) return workspace();
    const settings = readFeishuSettings();
    const tables = configuredFeishuTables();
    const config = options.readConfig();
    database ??= openAutomationDatabase().database;
    runner = new FeishuTaskRunner({
      ...options,
      tables,
      url: settings.tableUrl,
      sheet: config.sheetName,
      pollSeconds: Number(normalizeFeishuPollSeconds(config.pollSeconds)),
      journal: new FeishuTaskRepository(database, options.platform),
      changed: () => {
        if (notification) return;
        notification = setTimeout(() => {
          notification = undefined;
          emitIpcEvent(`${options.channel}:changed`);
        }, 150);
      },
    });
    lockFeishuSettings(owner, true);
    runner.start();
    return workspace();
  });
  trpcIpc.handle(`${options.channel}:pause`, async () => {
    await stop();
    return workspace();
  });
  return {
    stop,
    close: async () => {
      await stop();
      clearTimeout(notification);
      notification = undefined;
      database?.close();
      database = undefined;
    },
  };
}
