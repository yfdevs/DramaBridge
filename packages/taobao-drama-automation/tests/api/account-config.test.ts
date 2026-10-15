import assert from "node:assert/strict";
import test from "node:test";
import { fetchTaobaoDramaAccounts } from "../../src/api/account-config.js";

test("loads only enabled Taobao accounts from the backend", async () => {
  const accounts = await fetchTaobaoDramaAccounts("http://backend.test", async () => new Response(JSON.stringify({
    code: 0,
    data: { total: 2, data: [
      { id: 1, accountId: "tb-1", accountName: "淘宝一号", status: "ON", sortNo: 2 },
      { id: 2, accountId: "tb-off", accountName: "停用账号", status: "OFF", sortNo: 1 },
    ] },
  }), { status: 200 }));
  assert.deepEqual(accounts.map((account) => account.accountId), ["tb-1"]);
});

test("loads every Taobao account page and preserves the RPA profile key", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const accounts = await fetchTaobaoDramaAccounts("http://backend.test/", async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    const page = Number(body.page);
    const data = page === 1
      ? Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          accountId: `tb-${index + 1}`,
          accountName: `淘宝${index + 1}`,
          rpaProfileKey: `profile-${index + 1}`,
          status: "ON",
          sortNo: index + 1,
        }))
      : [{ id: 101, accountId: "tb-101", accountName: "淘宝101", status: "ON", sortNo: 101 }];
    return new Response(JSON.stringify({ code: 0, msg: "操作成功", data: { total: 101, data } }));
  });

  assert.equal(accounts.length, 101);
  assert.equal(accounts[0]?.rpaProfileKey, "profile-1");
  assert.deepEqual(requestBodies.map((body) => body.page), [1, 2]);
  assert.equal(requestBodies[0]?.status, "ON");
});
