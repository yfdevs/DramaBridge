import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKuaishouWorkerId,
  getKuaishouWorkerId,
} from "../../electron/platforms/kuaishou-drama/worker-identity";

test("worker identity combines a stable hashed computer identifier with a unique process UUID", () => {
  const first = buildKuaishouWorkerId("computer-machine-guid");
  const second = buildKuaishouWorkerId("computer-machine-guid");
  assert.notEqual(first, second);
  assert.equal(first.slice(0, 42), second.slice(0, 42));
  assert.notEqual(first.slice(0, 42), buildKuaishouWorkerId("another-computer").slice(0, 42));
  assert.equal(first.includes("computer-machine-guid"), false);
  assert.ok(first.length <= 128);
  assert.match(first, /^kuaishou-[a-f0-9]{32}-[a-f0-9-]{36}$/);
});

test("all accounts and service restarts in one execution process share its original identity", async () => {
  const [first, second] = await Promise.all([
    getKuaishouWorkerId(() => "installation-fallback"),
    getKuaishouWorkerId(() => "different-fallback"),
  ]);
  assert.equal(first, second);
});
