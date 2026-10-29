import assert from "node:assert/strict";
import test from "node:test";
import { selectTaobaoAccounts } from "../../electron/platforms/taobao-drama/account-selection";

const accounts = [{ accountId: "tb-1" }, { accountId: "tb-2" }, { accountId: "tb-3" }];

test("starts only selected Taobao accounts and deduplicates the selection", () => {
  assert.deepEqual(selectTaobaoAccounts(accounts, ["tb-3", "tb-1", "tb-1"]), [accounts[0], accounts[2]]);
});

test("missing, empty or malformed selections cannot default to every account", () => {
  for (const selection of [undefined, null, [], "tb-1", [1], [""], ["tb-1", null]]) {
    assert.throws(() => selectTaobaoAccounts(accounts, selection), /至少选择/);
  }
});

test("a stale selection fails before launching any remaining enabled accounts", () => {
  assert.throws(() => selectTaobaoAccounts(accounts, ["tb-1", "disabled"]), /已停用或不存在/);
});
