import assert from "node:assert/strict";
import test from "node:test";
import type { FeishuTables, TableSnapshot } from "../../packages/feishu/src/index";
import {
  KuaishouFeishuRunner,
  sourceKey,
} from "../../electron/platforms/kuaishou-drama/recreation-feishu";
import type { RecreationTask } from "../../src/platforms/kuaishou-drama/recreation-types";
import type { TaskTableOptions } from "../../electron/integrations/feishu/task-runner";

const wait = async (condition: () => boolean) => {
  const until = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > until) throw new Error("runner timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
function fixture(options: TaskTableOptions = {}) {
  const table: TableSnapshot = {
    spreadsheet: "book",
    sheet: {
      sheet_id: "sheet",
      title: "快手二创",
      grid_properties: { row_count: 3, column_count: 6 },
    },
    headers: ["剧名", "集数", "原百度链接", "二创百度链接", "版本1", "备注"],
    rows: [
      {
        number: 2,
        values: ["测试剧", "80", "https://pan.baidu.com/s/1test?pwd=abcd", "", "新剧名", ""],
      },
    ],
  };
  const saved = new Map<string, RecreationTask>();
  const styles: boolean[] = [];
  let failWrite = false;
  const tables = {
    read: async () => structuredClone(table),
    markError: async (_table: TableSnapshot, _row: number, _col: number, failed: boolean) => {
      styles.push(failed);
    },
    writeCells: async (
      _table: TableSnapshot,
      row: number,
      cells: { column: number; value: string }[],
    ) => {
      if (failWrite) throw new Error("网络断开");
      const found = table.rows.find((item) => item.number === row)!;
      cells.forEach((cell) => {
        found.values[cell.column] = cell.value;
      });
    },
  } as unknown as FeishuTables;
  const journal = {
    get: (key: string) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    save: (task: RecreationTask) => {
      saved.set(task.id, structuredClone(task));
    },
  };
  let calls = 0;
  const transferredVersions: Array<string[] | undefined> = [];
  let failTransfer = false;
  let gate: Promise<void> | undefined;
  const create = () =>
    new KuaishouFeishuRunner({
      ...options,
      tables,
      url: "url",
      sheet: "快手二创",
      pollSeconds: 60,
      journal,
      changed: () => {},
      transfer: async (input) => {
        calls++;
        transferredVersions.push(input.versions);
        await gate;
        if (failTransfer) throw new Error("源链接失效");
        table.rows[0].number = 7; // A user moved the row during transfer.
        return { path: "/result", shareUrl: "https://pan.baidu.com/s/1result?pwd=1234" };
      },
    });
  return {
    gate: (value: Promise<void>) => {
      gate = value;
    },
    table,
    styles,
    saved,
    create,
    calls: () => calls,
    transferredVersions,
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    failTransfer: (value: boolean) => {
      failTransfer = value;
    },
  };
}

test("快手统一目录只处理一次，传入全部封面标题并在回写失败后复用链接", async () => {
  const f = fixture({ singleBundle: true, plainLink: true });
  f.table.headers.push("版本2");
  f.table.rows[0].values.push("第二个新剧名");
  f.failWrite(true);
  const runner = f.create();
  runner.start();
  try { await wait(() => runner.status().phase === "error"); }
  finally { await runner.stop(); }
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.transferredVersions, [["新剧名", "第二个新剧名"]]);
  assert.equal(runner.status().current?.results.length, 1);
  assert.equal(runner.status().current?.results[0].shareLayout, "bundle");
  f.failWrite(false);
  const resume = f.create();
  resume.start();
  try { await wait(() => resume.status().phase === "waiting"); }
  finally { await resume.stop(); }
  assert.equal(f.calls(), 1);
  assert.equal(f.table.rows[0].values[3], "https://pan.baidu.com/s/1result?pwd=1234");
});

for (const [platform, column, ratio] of [
  ["微信二创", "二创百度链接", 0.6],
  ["TikTok 转存", "单层文件夹链接", 1],
] as const) {
  test(`${platform} uses its result column, episode target and resumes a failed write without retransferring`, async () => {
    const f = fixture({
      resultColumn: column,
      episodeRatio: ratio,
      includeVersions: false,
      plainLink: true,
    });
    f.table.headers[3] = column;
    const runner = f.create();
    f.failWrite(true);
    runner.start();
    try {
      await wait(() => runner.status().phase === "error");
    } finally {
      await runner.stop();
    }
    assert.equal(f.calls(), 1);
    assert.equal(runner.status().current?.downloadCount, Math.ceil(80 * ratio));
    f.failWrite(false);
    const resume = f.create();
    resume.start();
    try {
      await wait(() => resume.status().phase === "waiting");
    } finally {
      await resume.stop();
    }
    assert.equal(f.calls(), 1);
    assert.equal(f.table.rows[0].values[3], "https://pan.baidu.com/s/1result?pwd=1234");
    assert.equal(f.table.rows[0].values[5], "");
  });
}

test("does not claim rows while required cells are still being entered", async () => {
  for (const missing of [0, 1, 2]) {
    const f = fixture();
    f.table.rows[0].values[missing] = "   ";
    const runner = f.create();
    runner.start();
    try {
      await wait(() => runner.status().phase === "waiting");
    } finally {
      await runner.stop();
    }
    assert.equal(f.calls(), 0);
    assert.equal(f.saved.size, 0);
    assert.equal(f.styles.length, 0);
    assert.equal(f.table.rows[0].values[5], "");
    f.table.rows[0].values[missing] = ["测试剧", "80", "https://pan.baidu.com/s/1test"][missing];
    const ready = f.create();
    ready.start();
    try {
      await wait(() => ready.status().phase === "waiting");
    } finally {
      await ready.stop();
    }
    assert.equal(f.calls(), 2);
  }
});

test("matches a moved row and writes every version link; completed input is idempotent", async () => {
  const f = fixture();
  const runner = f.create();
  const key = sourceKey(f.table, f.table.rows[0].values);
  runner.start();
  try {
    await wait(() => runner.status().phase === "waiting");
  } finally {
    await runner.stop();
  }
  assert.equal(f.calls(), 2);
  assert.equal(f.table.rows[0].number, 7);
  assert.match(f.table.rows[0].values[3], /测试剧/);
  assert.match(f.table.rows[0].values[3], /新剧名/);
  assert.equal(f.saved.get(key)?.state, "completed");
  const again = f.create();
  again.start();
  try {
    await wait(() => again.status().phase === "waiting");
  } finally {
    await again.stop();
  }
  assert.equal(f.calls(), 2);
});

test("legacy flat links are preserved until the result is cleared, then regenerated", async () => {
  const f = fixture();
  const first = f.create();
  first.start();
  try {
    await wait(() => first.status().phase === "waiting");
  } finally {
    await first.stop();
  }
  for (const task of f.saved.values()) {
    for (const version of task.results) delete version.shareLayout;
  }
  const keep = f.create();
  keep.start();
  try {
    await wait(() => keep.status().phase === "waiting");
  } finally {
    await keep.stop();
  }
  assert.equal(f.calls(), 2);
  f.table.rows[0].values[3] = "";
  const refresh = f.create();
  refresh.start();
  try {
    await wait(() => refresh.status().phase === "waiting");
  } finally {
    await refresh.stop();
  }
  assert.equal(f.calls(), 4);
  assert.ok(
    [...f.saved.values()][0].results.every((version) => version.shareLayout === "directory"),
  );
});

test("writeback outage preserves success and only retries the write on restart", async () => {
  const f = fixture();
  f.failWrite(true);
  const runner = f.create();
  runner.start();
  try {
    await wait(() => runner.status().phase === "error");
  } finally {
    await runner.stop();
  }
  assert.equal(f.calls(), 2);
  assert.equal([...f.saved.values()][0].state, "completed");
  f.failWrite(false);
  const again = f.create();
  again.start();
  try {
    await wait(() => again.status().phase === "waiting");
  } finally {
    await again.stop();
  }
  assert.equal(f.calls(), 2);
  assert.match(f.table.rows[0].values[3], /1result/);
});

test("failure marks the note red, skips it until cleared, then resumes", async () => {
  const f = fixture();
  f.failTransfer(true);
  const runner = f.create();
  runner.start();
  try {
    await wait(() => runner.status().phase === "waiting");
  } finally {
    await runner.stop();
  }
  assert.match(f.table.rows[0].values[5], /源链接失效/);
  assert.ok(f.styles.includes(true));
  const skipped = f.create();
  skipped.start();
  try {
    await wait(() => skipped.status().phase === "waiting");
  } finally {
    await skipped.stop();
  }
  assert.equal(f.calls(), 1);
  f.table.rows[0].values[5] = "";
  f.failTransfer(false);
  const retry = f.create();
  retry.start();
  try {
    await wait(() => retry.status().phase === "waiting");
  } finally {
    await retry.stop();
  }
  assert.equal(f.calls(), 3);
  assert.equal(f.table.rows[0].values[5], "");
  assert.equal(f.styles.at(-1), false);
});

test("duplicate rows never start transfers or overwrite results", async () => {
  const f = fixture();
  f.table.rows.push({ ...structuredClone(f.table.rows[0]), number: 3 });
  const runner = f.create();
  runner.start();
  try {
    await wait(() => runner.status().phase === "error");
  } finally {
    await runner.stop();
  }
  assert.equal(f.calls(), 0);
  assert.match(runner.status().error!, /重复/);
});

test("failed transfer with failed writeback retries its note before any transfer", async () => {
  const f = fixture();
  f.failTransfer(true);
  f.failWrite(true);
  const runner = f.create();
  runner.start();
  try {
    await wait(() => runner.status().phase === "error");
  } finally {
    await runner.stop();
  }
  assert.equal(f.calls(), 1);
  f.failTransfer(false);
  f.failWrite(false);
  const resumed = f.create();
  resumed.start();
  try {
    await wait(() => resumed.status().phase === "waiting");
  } finally {
    await resumed.stop();
  }
  assert.equal(f.calls(), 1);
  assert.match(f.table.rows[0].values[5], /源链接失效/);
});

test("stop waits for the current drama and never claims the next row", async () => {
  const f = fixture();
  let release!: () => void;
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.table.rows.push({
    number: 3,
    values: ["下一部", "60", "https://pan.baidu.com/s/1next", "", "", ""],
  });
  const runner = f.create();
  runner.start();
  // Stop while the first transfer continuation is pending; completed versions still get written.
  try {
    await wait(() => f.calls() === 1);
    const stopping = runner.stop();
    assert.equal(runner.status().stopping, true);
    release();
    await stopping;
  } finally {
    release();
    await runner.stop();
  }
  assert.equal(runner.status().running, false);
  assert.equal(runner.status().stopping, false);
  assert.equal(f.table.rows[1].values[3], "");
});
