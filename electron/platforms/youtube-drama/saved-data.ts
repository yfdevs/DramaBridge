import Database from "better-sqlite3";
import { youtubeTaskFailure } from "../../../src/platforms/youtube-drama/task-failure";
import type { YoutubeTask } from "../../../src/platforms/youtube-drama/service";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** Read the Python-owned queue without creating, migrating or recovering it. */
export function readYoutubeSavedData(
  root: string,
  route: string,
  settings: { paused: boolean },
  openDatabase = (file: string) => new Database(file, { readonly: true, fileMustExist: true }),
): unknown {
  const detail = /^\/api\/tasks\/([a-f0-9-]+)$/.exec(route);
  if (route !== "/api/tasks" && route !== "/api/accounts" && !detail)
    throw new Error("请先启动 YouTube 服务后执行此操作");
  const isFile = (file: string) => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  const tokenExists = (id: string) => {
    if (id !== "default") return /^[a-f0-9]{32}$/.test(id)
      && isFile(path.join(root, "data", "youtube-accounts", id, "token.json"));
    return isFile(path.join(root, "data", "credentials", "token.json"))
      || isFile(path.join(root, "token.json"));
  };
  const defaultAccount = { id: "default", name: "默认账号（原授权）", authorized: tokenExists("default") };
  const file = path.join(root, "data", "queue.sqlite3");
  if (!existsSync(file)) {
    if (detail) throw new Error("任务不存在");
    return route === "/api/accounts" ? { accounts: [defaultAccount] } : { tasks: [], settings };
  }
  const db = openDatabase(file);
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    if (route === "/api/accounts") {
      if (!tables.has("youtube_accounts")) return { accounts: [defaultAccount] };
      const columns = db.prepare("PRAGMA table_info(youtube_accounts)").all() as { name: string }[];
      const where = columns.some(column => column.name === "deleted") ? " WHERE deleted=0" : "";
      const rows = db.prepare("SELECT id,name,created FROM youtube_accounts" + where + " ORDER BY created,id").all() as { id: string; name: string; created: string }[];
      return { accounts: rows.map(account => ({ ...account, authorized: tokenExists(account.id) })) };
    }
    if (!tables.has("tasks")) {
      if (detail) throw new Error("任务不存在");
      return { tasks: [], settings };
    }
    const decode = (row: Record<string, unknown>) => {
      const item = { ...row };
      for (const key of ["payload", "progress", "result", "timings"])
        item[key] = typeof row[key] === "string" && row[key] ? JSON.parse(row[key] as string) : null;
      // Classify the latest legacy attempt before dropping private raw logs.
      if (item.status === "failed") {
        const failure = youtubeTaskFailure(item as YoutubeTask);
        if (failure) {
          item.error = failure.title;
          item.progress = { ...(item.progress as Record<string, unknown> | null), failure };
        }
      }
      // Credentials and download links do not belong in queue/detail responses.
      delete item.logs;
      const payload = item.payload as Record<string, unknown> | null;
      if (payload) delete payload.shareText;
      return item;
    };
    if (detail) {
      const row = db.prepare("SELECT * FROM tasks WHERE id=? AND status != 'deleted'").get(detail[1]) as Record<string, unknown> | undefined;
      if (!row) throw new Error("任务不存在");
      return decode(row);
    }
    const rows = db.prepare("SELECT * FROM tasks WHERE status != 'deleted' ORDER BY seq DESC LIMIT 500").all() as Record<string, unknown>[];
    return { tasks: rows.map(decode), settings };
  } finally {
    db.close();
  }
}
