import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaobaoExecutionRepository } from "../../electron/storage/taobao-drama/execution-repository";
import type { TaobaoExecutionRecord } from "@dramabridge/taobao-drama-automation";

test("SQLite journal survives reopening, retains the exact old report and isolates backend/account scopes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "taobao-executions-"));
  const filename = path.join(directory, "automation.sqlite");
  let database = new Database(filename);
  try {
    const store = new TaobaoExecutionRepository(database);
    const record: TaobaoExecutionRecord = { id: "execution-1", apiBaseUrl: "http://backend.test", accountId: "tb-1",
      taskId: 88, workerId: "old-process", attemptCount: 3, phase: "report-pending", checkpoints: [],
      claim: { code: 0, data: { workerId: "old-process", attemptCount: 3, payloadJson: { name: "剧名" } } },
      report: { taskId: 88, workerId: "old-process", attemptCount: 3, success: true, resultJson: { test: "中文" } },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.save(record);
    store.save({ ...record, id: "interrupted", taskId: 99, phase: "executing", report: undefined });
    store.save({ ...record, id: "another-live-process", taskId: 100, ownerProcessId: process.ppid, phase: "executing", report: undefined });
    assert.throws(() => store.save({ ...record, id: "duplicate-execution" }), /UNIQUE constraint/);
    database.close();
    database = new Database(filename);
    const reopened = new TaobaoExecutionRepository(database);
    reopened.recoverInterrupted();
    assert.deepEqual(reopened.get(record.id), record);
    assert.equal(reopened.get("interrupted")?.phase, "review-required");
    assert.equal(reopened.get("another-live-process")?.phase, "executing");
    assert.deepEqual(reopened.list("http://backend.test/", "tb-1").map((item) => item.id), [record.id, "interrupted", "another-live-process"]);
    assert.deepEqual(reopened.list("http://different-backend.test"), []);
    assert.deepEqual(reopened.list("http://backend.test", "tb-2"), []);
    reopened.save({ ...record, phase: "reported" });
    reopened.save({ ...record, id: "next-round", attemptCount: 4 });
    assert.equal(reopened.list("http://backend.test").length, 4);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
