import assert from "node:assert/strict";
import test from "node:test";
import { collectApprovedShortplayPages, type ApprovedShortplayListPage } from "../../src/app/shortplay-manage-page.js";

function page(number: number, totalCount: number | undefined = 200): ApprovedShortplayListPage {
  return { page: number, pageSize: 50, rawCount: totalCount === undefined ? (number < 3 ? 50 : 1) : Math.min(50, totalCount - (number - 1) * 50), totalCount, records: [], createdTopicIds: [] };
}

test("reads remaining pages concurrently with a maximum of three and restores page order", async () => {
  let active = 0, maximum = 0;
  const completion: number[] = [];
  const results = await collectApprovedShortplayPages(async number => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, (5 - number) * 5));
    completion.push(number); active--;
    return page(number);
  });
  assert.equal(maximum, 3);
  assert.deepEqual(results.map(result => result.page), [1, 2, 3, 4]);
  assert.deepEqual(completion, [1, 4, 3, 2]);
});

test("falls back to serial reads without a total count and stops at a short page", async () => {
  const calls: number[] = [];
  const results = await collectApprovedShortplayPages(async number => { calls.push(number); return { ...page(number), totalCount: undefined, rawCount: number < 3 ? 50 : 1 }; });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(results.length, 3);
});

test("rejects changed totals, missing pages and invalid pagination rather than syncing a partial list", async () => {
  await assert.rejects(collectApprovedShortplayPages(async number => ({ ...page(number), totalCount: number === 1 ? 200 : 201 })), /发生变化/);
  await assert.rejects(collectApprovedShortplayPages(async number => ({ ...page(number), rawCount: number === 2 ? 0 : 50 })), /发生变化/);
  await assert.rejects(collectApprovedShortplayPages(async () => page(0)), /分页异常/);
});

test("waits for outstanding reads on failure and never starts another page window", async () => {
  const calls: number[] = []; let active = 0;
  await assert.rejects(collectApprovedShortplayPages(async number => {
    calls.push(number);
    if (number === 2) throw new Error("429");
    active++;
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return page(number, 500);
  }), /429/);
  assert.equal(active, 0);
  assert.ok(calls.every(number => number <= 4));
});

test("cancelled list scans do not issue requests", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectApprovedShortplayPages(async () => { assert.fail("unexpected request"); }, controller.signal));
});
