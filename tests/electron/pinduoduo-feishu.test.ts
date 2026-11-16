import assert from "node:assert/strict";
import test from "node:test";
import type { FeishuTables, TableSnapshot } from "@dramabridge/feishu";
import { PinduoduoFeishuTables, readPinduoduoAccounts } from "../../electron/platforms/pinduoduo-drama/feishu";

function fixture() {
  const accountTable: TableSnapshot = {
    spreadsheet: "test", sheet: { sheet_id: "accounts", title: "拼多多账号实例", grid_properties: { row_count: 50, column_count: 20 } },
    headers: ["账号名称", "主播名称", "是否启用", "登录状态", "手机号"],
    rows: [
      { number: 2, values: ["账号A", "主播A", "是", "待登录", "17732354154"] },
      { number: 3, values: ["账号B", "主播B", "是", "待登录", "18027171189"] },
    ],
  };
  const taskTable: TableSnapshot = {
    spreadsheet: "test", sheet: { sheet_id: "tasks", title: "拼多多传剧任务", grid_properties: { row_count: 50, column_count: 20 } },
    headers: ["剧名", "集数", "发布账号", "百度网盘链接", "状态", "上传进度", "失败原因", "更新时间"], rows: [],
  };
  const sourceTable: TableSnapshot = {
    spreadsheet: "source", sheet: { sheet_id: "5d5b78", title: "拼多多-新剧", grid_properties: { row_count: 50, column_count: 4 } },
    headers: ["原剧名", "剧名", "网盘（原链接）", "网盘（拼多多）"],
    rows: [{ number: 2, values: ["原名", "测试剧", "https://pan.baidu.com/s/original", "https://pan.baidu.com/s/full-episodes 提取码: 1234"] }],
  };
  let failWrites = false;
  const hidden: number[] = [];
  const tables = {
    read: async (_url: string, title: string) => structuredClone(title === sourceTable.sheet.title ? sourceTable : title === accountTable.sheet.title ? accountTable : taskTable),
    hideColumn: async (_table: TableSnapshot, column: number) => { hidden.push(column); },
    ensureRows: async () => undefined,
    writeCells: async (table: TableSnapshot, number: number, cells: { column: number; value: string }[]) => {
      assert.notEqual(table.sheet.sheet_id, "5d5b78", "source sheet must never receive a write");
      if (failWrites) throw new Error("模拟飞书断网");
      const target = table.sheet.sheet_id === "accounts" ? accountTable : taskTable;
      const values = number === 1 ? target.headers : (() => {
        let row = target.rows.find(item => item.number === number);
        if (!row) { row = { number, values: [] }; target.rows.push(row); }
        return row.values;
      })();
      for (const cell of cells) values[cell.column] = cell.value;
    },
  } as unknown as FeishuTables;
  const cloud = new PinduoduoFeishuTables(tables, "https://example.feishu.cn/wiki/test");
  const accounts = readPinduoduoAccounts(accountTable);
  return { cloud, a: cloud.forAccount(accounts[0]!), b: cloud.forAccount(accounts[1]!), accountTable, taskTable, sourceTable, hidden, fail: (value: boolean) => { failWrites = value; } };
}
const drama = { id: 7, title: "测试剧", episodeCount: 120, gmtCreate: 1791002365363, demoUrl: "https://pan.baidu.com/s/test" };

test("Feishu separates identical platform IDs by account and serializes concurrent appends", async () => {
  const f = fixture(); await f.cloud.prepare();
  await Promise.all([f.a.upsertFromApprovedList([drama]), f.b.upsertFromApprovedList([drama])]);
  assert.equal(f.taskTable.rows.length, 2);
  assert.deepEqual(f.hidden, [8]);
  await f.a.markDownloading(7);
  const records = await f.cloud.list();
  assert.equal(records.find(r => r.accountProfileName === "账号A")?.status, "DOWNLOADING");
  assert.equal(records.find(r => r.accountProfileName === "账号B")?.status, "PENDING");
});

test("writeback re-finds task identity after rows move, without touching another account", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]); await f.b.upsertFromApprovedList([drama]);
  f.taskTable.rows[0]!.number = 20; f.taskTable.rows[1]!.number = 2;
  await f.a.markFailed(7, "DOWNLOAD", "下载失败");
  assert.equal(f.taskTable.rows.find(r => r.number === 20)?.values[6], "下载失败");
  assert.equal(f.taskTable.rows.find(r => r.number === 2)?.values[6], "");
});

test("publication intent survives restart and cannot be automatically retried", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]);
  await f.a.markDownloading(7); await f.a.markUploading(7);
  await f.a.prepareUploadBatches(7, 3, "manifest"); await f.a.markPublishing(7, 1);
  await f.a.recoverInterruptedRecords();
  assert.equal((await f.cloud.list())[0]?.status, "CONFIRM_REQUIRED");
  assert.equal((await f.a.findProcessableRecords()).length, 0);
  assert.equal(await f.cloud.resetFailed(), 0);
});

test("published batches resume from the cloud; changed input files fail closed", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]);
  await f.a.markDownloading(7); await f.a.prepareUploadBatches(7, 3, "files");
  await f.a.markPublishing(7, 1); await f.a.markUploadBatchPublished(7, 1);
  await f.a.markFailed(7, "UPLOAD", "第二批失败");
  assert.equal(await f.a.prepareUploadBatches(7, 3, "files"), 1);
  assert.equal(f.taskTable.rows[0]!.values[5], "50/120");
  await assert.rejects(f.a.prepareUploadBatches(7, 3, "different-files"), /素材或批次已变化/);
});

test("a Feishu write failure prevents marking publish intent, and disabling an account blocks publish", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]); f.fail(true);
  await assert.rejects(f.a.markPublishing(7, 1), /断网/);
  f.fail(false); f.accountTable.rows[0]!.values[2] = "否";
  await assert.rejects(f.a.markPublishing(7, 1), /停用/);
});

test("reads the full-episode source column, writes it to the task, and rejects duplicate tasks", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]);
  f.taskTable.rows[0]!.values[3] = "https://pan.baidu.com/s/corrected";
  const link = await f.a.resolveResource(7);
  assert.equal(link, "https://pan.baidu.com/s/full-episodes 提取码: 1234");
  assert.equal(f.taskTable.rows[0]!.values[3], link);
  const [record] = await f.a.findProcessableRecords();
  assert.equal(record?.resourceSource, "FEISHU");
  assert.equal(record?.demoUrl, link);
  f.taskTable.rows.push({ number: 3, values: [...f.taskTable.rows[0]!.values] });
  await assert.rejects(f.a.markDownloading(7), /重复/);
});

test("never uses the platform preview or original-link column when the full source is missing", async () => {
  const f = fixture(); f.sourceTable.rows[0]!.values[3] = "";
  await f.a.upsertFromApprovedList([drama]);
  assert.equal(f.taskTable.rows[0]!.values[3], "");
  await assert.rejects(f.a.resolveResource(7), /网盘（拼多多）.*为空/);
  assert.equal(f.taskTable.rows[0]!.values[3], "");
  assert.equal(f.taskTable.rows[0]!.values[4], "失败");
});

test("a failed source-link writeback rejects before downloading can begin", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]); f.fail(true);
  await assert.rejects(f.a.resolveResource(7), /断网/);
});

test("corrupt cloud metadata is never silently treated as a fresh task", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]);
  f.taskTable.rows[0]!.values[8] = "{broken";
  await assert.rejects(f.a.findProcessableRecords(), /运行数据损坏/);
});

test("human confirmation advances only the uncertain batch and leaves remaining batches pending", async () => {
  const f = fixture(); await f.a.upsertFromApprovedList([drama]);
  await f.a.markDownloading(7); await f.a.prepareUploadBatches(7, 3, "files");
  await f.a.markPublishing(7, 1); await f.a.markFailed(7, "PUBLISH", "响应丢失");
  await f.cloud.confirmPublication("账号A", 7, true);
  assert.equal(await f.a.prepareUploadBatches(7, 3, "files"), 1);
  assert.equal((await f.a.findProcessableRecords()).length, 1);
  assert.equal(f.taskTable.rows[0]!.values[5], "50/120");
});

test("sync does not override a manually excluded cloud task", async () => {
  const f = fixture();
  f.taskTable.rows.push({ number: 2, values: [drama.title, "120", "账号A", drama.demoUrl, "已发布"] });
  await f.a.upsertFromApprovedList([drama]);
  assert.equal(f.taskTable.rows[0]!.values[4], "已发布");
  assert.equal((await f.a.findProcessableRecords()).length, 0);
});

test("account phone and name uniqueness are validated before launching browsers", () => {
  const f = fixture(); f.accountTable.rows[1]!.values[4] = "17732354154";
  assert.throws(() => readPinduoduoAccounts(f.accountTable), /不能重复/);
});
