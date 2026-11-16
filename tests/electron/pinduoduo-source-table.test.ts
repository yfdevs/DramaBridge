import assert from "node:assert/strict";
import test from "node:test";
import type { TableSnapshot } from "@dramabridge/feishu";
import { indexPinduoduoSource, matchPinduoduoSource, PinduoduoSourceTable, validatePinduoduoSourceUrl } from "../../electron/platforms/pinduoduo-drama/source-table";
import { PINDUODUO_DEFAULT_SOURCE_TABLE_URL } from "../../src/platforms/pinduoduo-drama/defaults";

function sheet(rows: string[][]): TableSnapshot {
  return { spreadsheet: "source", sheet: { sheet_id: "5d5b78", title: "拼多多-新剧", grid_properties: { row_count: 10, column_count: 4 } },
    headers: ["原剧名", "剧名", "网盘（原链接）", "网盘（拼多多）"], rows: rows.map((values, i) => ({ number: i + 2, values })) };
}
test("pins the configured sheet and matches the renamed title's Pinduoduo link", async () => {
  const source = new PinduoduoSourceTable({ read: async () => sheet([["旧名", "新名", "https://pan.baidu.com/s/preview", "分享：https://pan.baidu.com/s/full 提取码: 5678"]]) }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  assert.equal((await source.resolve("新名")).shareText, "分享：https://pan.baidu.com/s/full 提取码: 5678");
  await assert.rejects(source.resolve("旧名"), /未找到/);
  await assert.rejects(source.resolve("新"), /未找到/);
});
test("fails closed for empty, invalid, ambiguous and wrong-sheet source data", async () => {
  assert.throws(() => matchPinduoduoSource(indexPinduoduoSource(sheet([["", "剧", "valid-old", ""]])), "剧"), /为空/);
  assert.throws(() => matchPinduoduoSource(indexPinduoduoSource(sheet([["", "剧", "", "https://example.com/not-baidu"]])), "剧"), /不是有效/);
  assert.throws(() => matchPinduoduoSource(indexPinduoduoSource(sheet([["", "剧", "", "https://pan.baidu.com/s/one"], ["", "剧", "", "https://pan.baidu.com/s/two"]])), "剧"), /同名记录/);
  const source = new PinduoduoSourceTable({ read: async () => ({ ...sheet([]), sheet: { ...sheet([]).sheet, sheet_id: "other" } }) }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  await assert.rejects(source.read(), /sheet.*不一致/);
  assert.throws(() => validatePinduoduoSourceUrl("https://example.com/wiki/test"), /请填写/);
});
test("coalesces concurrent read-only requests and propagates permission failures", async () => {
  let calls = 0;
  const source = new PinduoduoSourceTable({ read: async () => { calls++; return sheet([["", "剧", "", "https://pan.baidu.com/s/full"]]); } }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  await Promise.all([source.resolve("剧"), source.resolve("剧"), source.read()]);
  assert.equal(calls, 1);
  const denied = new PinduoduoSourceTable({ read: async () => { throw new Error("403 可读权限不足"); } }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  await assert.rejects(denied.resolve("剧"), /可读权限不足/);
});
