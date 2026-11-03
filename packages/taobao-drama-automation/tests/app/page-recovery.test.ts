import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { runWithTaobaoPageRecovery } from "../../src/app/page-recovery.js";
import type { TaobaoSubmitCheckpoint } from "../../src/shared/task-execution.js";

function fixture() {
  let created = 0;
  const replacement = { isClosed: () => false } as Page;
  const page = { isClosed: () => true, context: () => ({ newPage: async () => { created++; return replacement; } }) } as unknown as Page;
  return { page, replacement, created: () => created };
}

test("reopens an accidentally closed upload page within the same task", async () => {
  const f = fixture(); let attempts = 0; let recovered: Page | undefined;
  const result = await runWithTaobaoPageRecovery({
    page: f.page, isRunning: () => true, checkpoints: () => [],
    onRecovered: page => { recovered = page; },
    publish: async page => { attempts++; if (page === f.page) throw new Error("Target page has been closed"); return "success"; },
  });
  assert.equal(result, "success"); assert.equal(attempts, 2);
  assert.equal(recovered, f.replacement); assert.equal(f.created(), 1);
});

for (const reason of ["submitting", "stopped", "ordinary error"] as const) {
  test(`does not blindly retry ${reason}`, async () => {
    const f = fixture();
    if (reason === "ordinary error") f.page.isClosed = () => false;
    const error = new Error(reason);
    await assert.rejects(runWithTaobaoPageRecovery({
      page: f.page, isRunning: () => reason !== "stopped",
      checkpoints: () => reason === "submitting" ? [{ kind: "batch", state: "submitting", startEpisode: 1, endEpisode: 60 } as TaobaoSubmitCheckpoint] : [],
      onRecovered: () => {}, publish: async () => { throw error; },
    }), value => value === error);
    assert.equal(f.created(), 0);
  });
}

test("limits repeated page closures to three recoveries", async () => {
  const f = fixture(); f.replacement.isClosed = () => true;
  await assert.rejects(runWithTaobaoPageRecovery({
    page: f.page, isRunning: () => true, checkpoints: () => [],
    onRecovered: () => {}, publish: async () => { throw new Error("closed"); },
  }), /closed/);
  assert.equal(f.created(), 3);
});
