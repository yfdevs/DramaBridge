import assert from "node:assert/strict";
import test from "node:test";
import { isPendingSyncTask, runSyncTaskPage, selectSyncSource } from "../../electron/platforms/kuaishou-drama/account-sync-tasks";

test("sync task tabs close after success and after every failure without closing the shared session", async () => {
  const events: string[] = [];
  const page = { close: async () => { events.push("close"); } };
  assert.equal(await runSyncTaskPage(page, async () => { events.push("submit-settled"); return "done"; }), "done");
  for (const message of ["page failed", "[KUAISHOU_LOGIN_REQUIRED]", "invalid targets"]) {
    await assert.rejects(runSyncTaskPage(page, async () => { events.push(message); throw new Error(message); }), error => error instanceof Error && error.message === message);
  }
  assert.deepEqual(events, ["submit-settled", "close", "page failed", "close", "[KUAISHOU_LOGIN_REQUIRED]", "close", "invalid targets", "close"]);
});

const accounts = [{ accountId: "a", accountName: "剧场一" }, { accountId: "b", accountName: "剧场二" }];
test("source routing uses the row's ID or exact account name", () => {
  assert.equal(selectSyncSource("b", accounts)?.accountId, "b");
  assert.equal(selectSyncSource(" 剧场一 ", accounts)?.accountId, "a");
  assert.equal(selectSyncSource("剧场", accounts), undefined);
  assert.equal(selectSyncSource("unselected", accounts), undefined);
});
test("blank source does not select an implicit account", () => {
  assert.equal(selectSyncSource("", accounts.slice(0,1)), undefined);
  assert.equal(selectSyncSource("", accounts), undefined);
});
test("duplicate names require an ID, which takes precedence over name matching", () => {
  const duplicates = [{ accountId: "a", accountName: "剧场" }, { accountId: "b", accountName: "剧场" }];
  assert.throws(() => selectSyncSource("剧场", duplicates), /重名/);
  assert.equal(selectSyncSource("b", duplicates)?.accountId, "b");
});
test("pending eligibility ignores old remarks and missing targets", () => {
  const row = { source: "a", title: "剧名", status: " 未同步 ", note: "上次同步失败", targets: "" };
  assert.equal(isPendingSyncTask(row), true);
  assert.equal(isPendingSyncTask({ ...row, note: "已完成的历史备注" }), true);
  assert.equal(isPendingSyncTask({ ...row, status: "已同步" }), false);
  assert.equal(isPendingSyncTask({ ...row, status: "同步失败" }), false);
  assert.equal(isPendingSyncTask({ ...row, status: "" }), false);
  assert.equal(isPendingSyncTask({ ...row, source: " " }), false);
  assert.equal(isPendingSyncTask({ ...row, title: " " }), false);
  assert.equal(isPendingSyncTask({ ...row, status: "已同步" }), false);
  assert.equal(isPendingSyncTask({ ...row, status: "未同步" }), true);
});
