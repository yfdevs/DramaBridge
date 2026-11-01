import assert from "node:assert/strict";
import test from "node:test";
import { selectKuaishouAccounts } from "../../electron/platforms/kuaishou-drama/account-selection";

const accounts = [{ accountId: "ks-1" }, { accountId: "ks-2" }, { accountId: "ks-3" }];

test("starts only selected Kuaishou accounts and deduplicates the selection", () => {
  assert.deepEqual(selectKuaishouAccounts(accounts, ["ks-3", "ks-1", "ks-1"]), [
    accounts[0],
    accounts[2],
  ]);
});

test("missing, empty or malformed selections cannot default to every account", () => {
  for (const selection of [undefined, null, [], "ks-1", [1], [""], ["ks-1", null]]) {
    assert.throws(() => selectKuaishouAccounts(accounts, selection), /至少选择/);
  }
});

test("a stale selection fails before launching any remaining enabled accounts", () => {
  assert.throws(() => selectKuaishouAccounts(accounts, ["ks-1", "disabled"]), /已停用或不存在/);
});
