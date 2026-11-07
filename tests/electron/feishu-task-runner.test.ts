/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import type { FeishuTables, TableSnapshot } from "@dramabridge/feishu";
import { FeishuTaskRunner } from "../../electron/integrations/feishu/task-runner";
import type { RecreationTask } from "../../src/platforms/feishu/task-types";

async function runDuplicates(options: { reportingFails?: boolean; completedFirst?: boolean } = {}) {
  const table: TableSnapshot = {
    spreadsheet: "test",
    sheet: { sheet_id: "sheet", title: "tasks", grid_properties: { row_count: 5, column_count: 5 } },
    headers: ["剧名", "集数", "原百度链接", "二创百度链接", "备注"],
    rows: [
      { number: 2, values: ["重复剧", "10", "https://pan.baidu.com/s/source", options.completedFirst ? "existing" : "", ""] },
      { number: 3, values: ["重复剧", "10", "https://pan.baidu.com/s/source", "", ""] },
      { number: 4, values: ["重复剧", "10", "https://pan.baidu.com/s/source", "", ""] },
      { number: 5, values: ["后续剧", "10", "https://pan.baidu.com/s/next", "", ""] },
    ],
  };
  const marked: number[] = [];
  const transferred: string[] = [];
  const journal = new Map<string, RecreationTask>();
  const runner = new FeishuTaskRunner({
    tables: {
      read: async () => structuredClone(table),
      markError: async (_table: TableSnapshot, row: number, _column: number, failed: boolean) => {
        if (failed && options.reportingFails) throw new Error("write unavailable");
        if (failed) marked.push(row);
      },
      writeCells: async (_table: TableSnapshot, row: number, cells: { column: number; value: string }[]) => {
        for (const cell of cells) table.rows.find((item) => item.number === row)!.values[cell.column] = cell.value;
      },
    } as unknown as FeishuTables,
    url: "test", sheet: "tasks", pollSeconds: 60, includeVersions: false, plainLink: true,
    journal: { get: (key) => journal.get(key), save: (task) => { journal.set(task.id, structuredClone(task)); } },
    transfer: async ({ title }) => {
      transferred.push(title);
      return { path: title, shareUrl: "https://pan.baidu.com/s/result" };
    },
    changed: () => {},
  });
  // Drive individual polls without scheduling timers or using live services.
  const internal = runner as unknown as { state: { running: boolean }; scan(): Promise<void> };
  internal.state.running = true;
  await internal.scan();
  await internal.scan();
  return { table, transferred, marked, journal, status: runner.status() };
}

test("newer duplicates are reported once while original and later tasks complete", async () => {
  const result = await runDuplicates();
  assert.deepEqual(result.transferred, ["重复剧", "后续剧"]);
  assert.deepEqual(result.marked, [3, 4]);
  assert.match(result.table.rows[1].values[4], /失败：.*重复任务行/);
  assert.match(result.table.rows[2].values[4], /失败：.*重复任务行/);
  assert.equal(result.table.rows[1].values[3], "");
  assert.equal(result.table.rows[0].values[4], "");
  assert.equal(result.journal.size, 2);
  assert.equal(result.status.failed, 2);
  assert.equal(result.status.phase, "waiting");
});

test("duplicates of an already completed row do not reuse its result", async () => {
  const result = await runDuplicates({ completedFirst: true });
  assert.deepEqual(result.transferred, ["后续剧"]);
  assert.equal(result.table.rows[0].values[3], "existing");
  assert.deepEqual(result.marked, [3, 4]);
});

test("duplicate error writeback failures do not block subsequent tasks", async () => {
  const result = await runDuplicates({ reportingFails: true });
  assert.deepEqual(result.transferred, ["重复剧", "后续剧"]);
  assert.equal(result.status.phase, "waiting");
  assert.equal(result.status.error, "write unavailable");
});
