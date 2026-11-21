import assert from "node:assert/strict";
import test from "node:test";
import type { TableSnapshot } from "@dramabridge/feishu";
import { indexPinduoduoSource, matchPinduoduoSource, PinduoduoSourceTable, validatePinduoduoSourceUrl } from "../../electron/platforms/pinduoduo-drama/source-table";
import { PINDUODUO_DEFAULT_SOURCE_TABLE_URL } from "../../src/platforms/pinduoduo-drama/defaults";

function sheet(rows: string[][]): TableSnapshot {
  return { spreadsheet: "source", sheet: { sheet_id: "5d5b78", title: "拼多多-新剧", grid_properties: { row_count: 10, column_count: 4 } },
    headers: ["原剧名", "剧名", "网盘（原链接）", "网盘（拼多多）"], rows: rows.map((values, i) => ({ number: i + 2, values })) };
}

function fullSheet(rows: string[][]): TableSnapshot {
  return { ...sheet(rows), headers: ["剧名", "全集链接"],
    sheet: { ...sheet([]).sheet, sheet_id: "QeuDEm", title: "全集资源" } };
}

test("prefers QeuDEm and does not read the old table when both contain the title", async () => {
  const source = new PinduoduoSourceTable({ read: async (_url, _title, options) => {
    assert.equal(options?.sheetId, "QeuDEm", "old table must stay lazy when primary matches");
    return fullSheet([["同名剧", "https://pan.baidu.com/s/preferred"]]);
  } }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  const result = await source.resolve("同名剧");
  assert.equal(result.shareText, "https://pan.baidu.com/s/preferred");
  assert.match(result.sourceUrl!, /QeuDEm/);
});

test("loads fallback lazily, coalesces requests and indexes 100000 titles", async () => {
  let primary = 0, fallback = 0;
  const source = new PinduoduoSourceTable({ read: async (_url, _title, options) => {
    if (!options?.sheetId) { fallback++; return sheet([["", "原表剧", "https://pan.baidu.com/s/original", "https://pan.baidu.com/s/unused"]]); }
    primary++;
    assert.deepEqual(options.columns, ["剧名", "全集链接"]);
    assert.equal(options.sheetId, "QeuDEm");
    return fullSheet(Array.from({ length: 100000 }, (_, i) => [`剧${i}`, `https://pan.baidu.com/s/full${i}`]));
  } }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  const results = await Promise.all(Array.from({ length: 100 }, () => source.resolve("剧99999")));
  assert.ok(results.every(row => row.shareText.endsWith("full99999") && row.sourceUrl?.includes("QeuDEm")));
  assert.equal(primary, 1);
  assert.equal(fallback, 0);
  assert.match((await source.resolve("原表剧")).shareText, /original/);
  assert.equal(fallback, 1);
});

test("primary rejects conflicting, empty and invalid full links", async () => {
  for (const links of [[""], ["https://example.com/x"], ["https://pan.baidu.com/s/a", "https://pan.baidu.com/s/b"]]) {
    const source = new PinduoduoSourceTable({ read: async (_url, _title, options) => options?.sheetId
      ? fullSheet(links.map(link => ["剧", link])) : sheet([]) }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
    await assert.rejects(source.resolve("剧"), /全集链接/);
  }
});
test("pins the configured sheet and matches the renamed title's original link", async () => {
  const source = new PinduoduoSourceTable({ read: async (_url, _title, options) => options?.sheetId ? fullSheet([]) : sheet([["旧名", "新名", "分享：https://pan.baidu.com/s/full 提取码: 5678", "https://pan.baidu.com/s/unused"]]) }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  assert.equal((await source.resolve("新名")).shareText, "分享：https://pan.baidu.com/s/full 提取码: 5678");
  await assert.rejects(source.resolve("旧名"), /未找到/);
  await assert.rejects(source.resolve("新"), /未找到/);
});
test("fails closed for empty, invalid, ambiguous and wrong-sheet source data", async () => {
  assert.throws(() => matchPinduoduoSource(indexPinduoduoSource(sheet([["", "剧", "", "unused"]])), "剧"), /为空/);
  assert.throws(() => matchPinduoduoSource(indexPinduoduoSource(sheet([["", "剧", "https://example.com/not-baidu", ""]])), "剧"), /不是有效/);
  assert.throws(() => matchPinduoduoSource(indexPinduoduoSource(sheet([["", "剧", "https://pan.baidu.com/s/one", ""], ["", "剧", "https://pan.baidu.com/s/two", ""]])), "剧"), /同名记录/);
  const source = new PinduoduoSourceTable({ read: async () => ({ ...sheet([]), sheet: { ...sheet([]).sheet, sheet_id: "other" } }) }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  await assert.rejects(source.read(), /sheet.*不一致/);
  assert.throws(() => validatePinduoduoSourceUrl("https://example.com/wiki/test"), /请填写/);
});
test("coalesces concurrent read-only requests and propagates permission failures", async () => {
  let calls = 0;
  const source = new PinduoduoSourceTable({ read: async (_url, _title, options) => { calls++; return options?.sheetId ? fullSheet([["剧", "https://pan.baidu.com/s/full"]]) : sheet([]); } }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  await Promise.all([source.resolve("剧"), source.resolve("剧"), source.read()]);
  assert.equal(calls, 2);
  const denied = new PinduoduoSourceTable({ read: async () => { throw new Error("403 可读权限不足"); } }, PINDUODUO_DEFAULT_SOURCE_TABLE_URL);
  await assert.rejects(denied.resolve("剧"), /可读权限不足/);
});
