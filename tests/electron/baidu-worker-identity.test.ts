import assert from "node:assert/strict";
import test from "node:test";
import { buildBaiduWorkerId } from "../../electron/platforms/baidu-drama/worker-identity";

test("Baidu identities isolate computers and processes without disclosing the machine identifier", () => {
  const first = buildBaiduWorkerId("MACHINE-SECRET", "process-one");
  assert.equal(first, buildBaiduWorkerId(" machine-secret ", "process-one"));
  assert.notEqual(first, buildBaiduWorkerId("another", "process-one"));
  assert.notEqual(first, buildBaiduWorkerId("MACHINE-SECRET", "process-two"));
  assert.ok(first.length <= 128); assert.ok(!first.includes("MACHINE-SECRET"));
  assert.throws(() => buildBaiduWorkerId(" "));
  assert.throws(() => buildBaiduWorkerId("machine", "x".repeat(129)));
});
