import assert from "node:assert/strict";
import test from "node:test";
import { buildTaobaoWorkerId, getTaobaoWorkerId } from "../../electron/platforms/taobao-drama/worker-identity";

test("worker identity combines a stable hashed computer identifier with a unique process UUID", () => {
  const first = buildTaobaoWorkerId("computer-machine-guid");
  const second = buildTaobaoWorkerId("computer-machine-guid");
  assert.notEqual(first, second);
  assert.equal(first.slice(0, 39), second.slice(0, 39));
  assert.notEqual(first.slice(0, 39), buildTaobaoWorkerId("another-computer").slice(0, 39));
  assert.equal(first.includes("computer-machine-guid"), false);
  assert.ok(first.length <= 128);
  assert.match(first, /^taobao-[a-f0-9]{32}-[a-f0-9-]{36}$/);
});

test("all accounts and service restarts in one execution process share its original identity", async () => {
  const [first, second] = await Promise.all([
    getTaobaoWorkerId(() => "installation-fallback"), getTaobaoWorkerId(() => "different-fallback"),
  ]);
  assert.equal(first, second);
});
