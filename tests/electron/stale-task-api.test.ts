/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { discoverGlobalCleanupTasks, remoteProgressTime, type CleanupPlatform } from "../../electron/platforms/shared/stale-task-api";

for (const platform of ["taobao-drama", "kuaishou-drama", "wechat-drama"] as CleanupPlatform[]) {
  test(`${platform} scans every account and worker in pages of 100`, async () => {
    const pages: number[] = []; const observed: string[] = [];
    await discoverGlobalCleanupTasks(platform, "https://backend.test", async (_endpoint, body) => {
      assert.equal(body.accountId, undefined); assert.equal(body.videoAccountId, undefined);
      assert.equal(body.pageSize, 100);
      assert.equal(body[platform === "wechat-drama" ? "rpaStatus" : "status"], "UPLOADING");
      const page = Number(body.page); pages.push(page);
      const start = (page - 1) * 100;
      return { code: 0, data: { total: 205, data: Array.from({ length: Math.min(100, 205 - start) }, (_, i) => ({
        id: start + i + 1, status: "UPLOADING", rpaStatus: "UPLOADING", accountId: `account-${start + i}`,
        videoAccountId: `channel-${start + i}`, rpaWorkerId: `computer-${start + i}`,
        rpaAttemptCount: 3, rpaClaimTime: "2026-11-04T01:00:00Z", updateTime: "2026-11-04T02:00:00Z",
      })) } };
    }, (identity, timestamp) => {
      assert.deepEqual(pages, [1, 2, 3]);
      assert.equal(timestamp, Date.parse("2026-11-04T02:00:00Z"));
      observed.push(identity.workerId);
    });
    assert.equal(observed.length, 205); assert.equal(new Set(observed).size, 205);
  });
}

test("uses the later claim or update time and skips invalid claim dates", () => {
  assert.equal(remoteProgressTime({ id: 1, rpaClaimTime: "2026-11-04T05:00:00Z", updateTime: "2026-11-04T01:00:00Z" }), Date.parse("2026-11-04T05:00:00Z"));
  assert.equal(remoteProgressTime({ id: 1, rpaClaimTime: "invalid", updateTime: "2026-11-04T01:00:00Z" }), undefined);
});

test("does not discover unclaimed tasks or tasks without execution ownership", async () => {
  let count = 0;
  await discoverGlobalCleanupTasks("taobao-drama", "https://backend.test", async () => ({ code: 0, data: { data: [
    { id: 1, status: "READY", accountId: "a", rpaWorkerId: "w", rpaAttemptCount: 1, rpaClaimTime: "2026-11-04T01:00:00Z" },
    { id: 2, status: "UPLOADING", accountId: "a", rpaClaimTime: "2026-11-04T01:00:00Z" },
  ] } }), () => { count++; });
  assert.equal(count, 0);
});
