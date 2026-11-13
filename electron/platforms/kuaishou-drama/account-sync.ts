import { createHash } from "node:crypto";
import type { TableSnapshot } from "@dramabridge/feishu";
import type { AccountSyncState } from "../../../src/platforms/kuaishou-drama/account-sync-service";
import { trpcIpc as ipcMain } from "../../ipc";
import { configuredFeishuTables, readFeishuSettings, lockFeishuSettings } from "../../integrations/feishu";
import { isPendingSyncTask, selectSyncSource, type SyncSourceAccount } from "./account-sync-tasks";

const sheetName = "快手账号同步";
export function syncColumns(table: TableSnapshot) {
  const headers = table.headers.map(item => item.trim());
  for (const name of ["剧名", "来源账号", "同步账号", "同步状态", "备注"]) {
    if (headers.filter(item => item === name).length !== 1) throw new Error(`快手账号同步表需要唯一的“${name}”列`);
  }
  return { title: headers.indexOf("剧名"), source: headers.indexOf("来源账号"), targets: headers.indexOf("同步账号"), status: headers.indexOf("同步状态"), note: headers.indexOf("备注") };
}
type RecordEntry = { phase: "completed" | "failed"; error?: string };
let state: AccountSyncState = { running: false, stopping: false, message: "选择来源账号后开始同步", completed: 0, failed: 0 };
let cycle: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let close: (() => Promise<void>) | undefined;
let starting = false;
export async function stopKuaishouAccountSync() {
  state.running = false; state.stopping = !!cycle; clearTimeout(timer);
  await cycle;
  await close?.(); close = undefined;
  state.stopping = false; state.message = "同步已停止";
  lockFeishuSettings("kuaishou-account-sync", false);
}

export function registerKuaishouAccountSyncHandlers(options: {
  prepare: (id: string) => Promise<SyncSourceAccount & { credentialStatePath: string; userDataDir: string }>;
}) {
  ipcMain.handle("kuaishou-drama:account-sync:status", () => ({ ...state }));
  ipcMain.handle("kuaishou-drama:account-sync:stop", async () => { await stopKuaishouAccountSync(); return { ...state }; });
  ipcMain.handle("kuaishou-drama:account-sync:start", async (_event, input: unknown) => {
    if (state.running || starting || state.stopping) throw new Error("同步正在运行或停止中");
    if (!Array.isArray(input) || !input.length || input.some(id => typeof id !== "string" || !id.trim())) throw new Error("请选择至少一个来源账号");
    const ids = [...new Set(input as string[])];
    starting = true;
    lockFeishuSettings("kuaishou-account-sync", true);
    try {
      const tables = configuredFeishuTables();
      const url = readFeishuSettings().tableUrl;
      await tables.read(url, sheetName).then(syncColumns);
      const accounts: Array<SyncSourceAccount & { credentialStatePath: string; userDataDir: string }> = [];
      for (const id of ids) accounts.push(await options.prepare(id));
      const runtime = await import("@dramabridge/kuaishou-drama-automation");
      await close?.(); close = undefined;
      const sessions = new Map<string, Awaited<ReturnType<typeof runtime.openKuaishouAccountSync>>>();
      close = async () => { await Promise.all([...sessions.values()].map(session => session.close())); };
      for (const account of accounts) {
        const session = await runtime.openKuaishouAccountSync(account);
        sessions.set(account.accountId, session);
        session.context.on("close", () => {
          if (!state.running) return;
          state.running = false; clearTimeout(timer);
          state.error = `“${account.accountName}”的同步浏览器已关闭，请重新启动同步`;
          if (!cycle) lockFeishuSettings("kuaishou-account-sync", false);
        });
      }
      if ([...sessions.values()].some(session => !session.isConnected())) throw new Error("来源账号浏览器已关闭，请重新启动同步");
      state = { running: true, stopping: false, message: "正在读取未同步任务", completed: 0, failed: 0, accountIds: ids };
      // Only retain results awaiting writeback within this run, never past task decisions.
      const pendingWritebacks = new Map<string, RecordEntry>();
      const isPendingRow = (snapshot: TableSnapshot, values: string[]) => {
        const columns = syncColumns(snapshot);
        return isPendingSyncTask({ source: values[columns.source] || "", title: values[columns.title] || "", status: values[columns.status] || "" });
      };
      const keyFor = (table: TableSnapshot, values: string[], id: string) => {
        const c = syncColumns(table);
        const targets = [...new Set((values[c.targets] || "").split(/[,，;；\n]+/).map(value => value.trim()).filter(Boolean))].sort();
        return createHash("sha256").update(JSON.stringify([table.spreadsheet, table.sheet.sheet_id, id, values[c.title]?.trim(), targets])).digest("hex");
      };
      const scan = async () => {
        state.error = undefined;
        const table = await tables.read(url, sheetName);
        const c = syncColumns(table);
        for (const row of table.rows) {
          if (!state.running) break;
          if (!isPendingRow(table, row.values)) continue;
          let account: SyncSourceAccount | undefined;
          try { account = selectSyncSource(row.values[c.source] || "", accounts); }
          catch (error) {
            // Re-find the unchanged task before writing a source-selection error.
            const fresh = await tables.read(url, sheetName);
            const fc = syncColumns(fresh);
            const unchanged = fresh.rows.filter(item => ["title", "source", "targets"].every(key => item.values[fc[key as keyof typeof fc]] === row.values[c[key as keyof typeof c]]));
            if (unchanged.length !== 1) throw new Error("来源账号缺失的任务存在重复行或已被修改，请先修正工作表");
            const target = unchanged[0]!;
            if (!isPendingRow(fresh, target.values)) continue;
            await tables.writeCells(fresh, target.number, [{ column: fc.status, value: "同步失败" }, { column: fc.note, value: error instanceof Error ? error.message : String(error) }]);
            state.failed++;
            continue;
          }
          if (!account) continue;
          const id = account.accountId;
          const belongsToAccount = (snapshot: TableSnapshot, values: string[]) => {
            try { return selectSyncSource(values[syncColumns(snapshot).source] || "", accounts)?.accountId === id; }
            catch { return false; }
          };
          const key = keyFor(table, row.values, id);
          let entry = pendingWritebacks.get(key);
          state.current = row.values[c.title]; state.currentAccountName = account.accountName; state.message = `正在同步：${account.accountName} / ${state.current}`;
          if (!entry) {
            const page = await sessions.get(id)!.context.newPage();
            try {
              await runtime.syncKuaishouAccounts(page, row.values[c.title]!, runtime.parseSyncAccounts(row.values[c.targets] || ""), () => { state.message = `正在提交：${account.accountName} / ${state.current}`; }, () => { state.message = "已收到同步结果，等待页面稳定"; });
              entry = { phase: "completed" };
              await page.close().catch(() => undefined);
            } catch (error) {
              if (error instanceof Error && error.message.includes("[KUAISHOU_LOGIN_REQUIRED]")) {
                state.message = `请在已打开的浏览器中登录“${account.accountName}”，登录后继续同步`;
                await page.close().catch(() => undefined);
                return;
              }
              entry = { phase: "failed", error: error instanceof Error ? error.message : String(error) };
              // Failed task tabs remain open until the user stops the synchronization browser.
            }
            pendingWritebacks.set(key, entry);
          }
          const fresh = await tables.read(url, sheetName);
          const freshColumns = syncColumns(fresh);
          const rows = fresh.rows.filter(item => isPendingRow(fresh, item.values) && belongsToAccount(fresh, item.values) && keyFor(fresh, item.values, id) === key);
          if (!rows.length) { pendingWritebacks.delete(key); continue; }
          const target = rows[0]!;
          await tables.writeCells(fresh, target.number, [
            { column: freshColumns.status, value: entry.phase === "completed" ? "已同步" : "同步失败" },
            { column: freshColumns.note, value: entry.error || "" },
          ]);
          pendingWritebacks.delete(key);
          if (entry.phase === "completed") state.completed++; else state.failed++;
        }
        state.message = "等待未同步任务，每 5 秒读取一次";
      };
      const tick = () => {
        cycle = scan().catch(error => { state.error = error instanceof Error ? error.message : String(error); state.message = "读取或回写失败，5 秒后重试"; }).finally(() => {
          cycle = undefined;
          if (state.running) timer = setTimeout(tick, 5_000);
          else lockFeishuSettings("kuaishou-account-sync", false);
        });
      };
      tick(); return { ...state };
    } catch (error) { await close?.(); close = undefined; lockFeishuSettings("kuaishou-account-sync", false); throw error; }
    finally { starting = false; }
  });
}
