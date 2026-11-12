import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readYoutubeSavedData } from "../../electron/platforms/youtube-drama/saved-data";

const open = (file: string) => new DatabaseSync(file, { readOnly: true }) as unknown as ReturnType<NonNullable<Parameters<typeof readYoutubeSavedData>[3]>>;

test("stopped YouTube reads tasks, details and account authorization without changing its database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "youtube-offline-"));
  try {
    const data = path.join(root, "data");
    await mkdir(path.join(data, "credentials"), { recursive: true });
    await writeFile(path.join(data, "credentials", "token.json"), "secret-never-read");
    const file = path.join(data, "queue.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE tasks (seq INTEGER PRIMARY KEY, id TEXT, status TEXT, payload TEXT, progress TEXT, result TEXT, timings TEXT, logs TEXT, error TEXT);
      CREATE TABLE youtube_accounts (id TEXT, name TEXT, created TEXT, deleted INTEGER DEFAULT 0);`);
    db.prepare("INSERT INTO tasks(seq,id,status,payload,progress,result,timings,logs) VALUES (?,?,?,?,?,?,?,?)").run(1, "abc-def", "paused", JSON.stringify({ resourceName: "测试剧", shareText: "private-share" }), JSON.stringify({ stage: "uploading", percent: 42 }), null, "{}", "private-log");
    db.prepare("INSERT INTO tasks(seq,id,status,payload,progress,result,timings,logs) VALUES (?,?,?,?,?,?,?,?)").run(2, "dead", "deleted", "{}", null, null, "{}", "");
    for (const [id, deleted] of [["default", 0], ["a".repeat(32), 0], ["b".repeat(32), 1]] as const)
      db.prepare("INSERT INTO youtube_accounts VALUES (?,?,?,?)").run(id, id, "2026-11-12", deleted);
    db.prepare("UPDATE tasks SET status='failed',error=?,logs=? WHERE id='abc-def'").run(
      "分离 / 上传程序退出，代码 1。请查看下方执行日志后重试",
      "开始 / 恢复任务\ninvalid_grant\n开始 / 恢复任务\ntoken 已失效，需要重新授权…");
    db.close();
    const before = await readFile(file);
    const list = readYoutubeSavedData(root, "/api/tasks", { paused: true }, open) as any;
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].status, "failed");
    assert.equal(list.tasks[0].progress.failure.code, "AUTH_INVALID");
    assert.equal(list.tasks[0].error, "账号授权已失效");
    assert.equal(list.tasks[0].progress.percent, 42);
    assert.equal(list.tasks[0].logs, undefined);
    assert.equal(list.tasks[0].payload.shareText, undefined);
    assert.equal(list.settings.paused, true);
    const detail = readYoutubeSavedData(root, "/api/tasks/abc-def", { paused: false }, open) as any;
    assert.equal(detail.id, "abc-def");
    assert.equal(detail.progress.failure.code, "AUTH_INVALID");
    assert.equal(detail.logs, undefined);
    assert.throws(() => readYoutubeSavedData(root, "/api/tasks/dead", { paused: false }, open), /任务不存在/);
    const accounts = readYoutubeSavedData(root, "/api/accounts", { paused: false }, open) as any;
    assert.deepEqual(accounts.accounts.map((a: any) => [a.id, a.authorized]), [["a".repeat(32), false], ["default", true]]);
    assert.deepEqual(await readFile(file), before);
    assert.throws(() => readYoutubeSavedData(root, "/api/tasks/abc-def/resume", { paused: false }, open), /请先启动/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("viewing YouTube before its first start does not create a database, and corruption is surfaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "youtube-offline-new-"));
  try {
    assert.deepEqual(readYoutubeSavedData(root, "/api/tasks", { paused: false }, open), { tasks: [], settings: { paused: false } });
    const accounts = readYoutubeSavedData(root, "/api/accounts", { paused: false }, open) as any;
    assert.equal(accounts.accounts[0].authorized, false);
    await assert.rejects(readFile(path.join(root, "data", "queue.sqlite3")), { code: "ENOENT" });
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data", "queue.sqlite3"), "corrupt database");
    assert.throws(() => readYoutubeSavedData(root, "/api/tasks", { paused: false }, open));
  } finally { await rm(root, { recursive: true, force: true }); }
});
