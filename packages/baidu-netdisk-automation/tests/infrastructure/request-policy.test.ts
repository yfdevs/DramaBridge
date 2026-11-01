import assert from "node:assert/strict";
import test from "node:test";
import { baiduApiError, createBaiduRequestGate } from "../../src/infrastructure/request-policy.js";

test("risk responses retain diagnostics and stop queued requests without retrying validation", async () => {
  const gate = createBaiduRequestGate(0, 1000);
  for (const code of [8001, 8011, 110, 8048]) {
    const error = baiduApiError({ errno: code, request_id: "trace-123", token: "secret" }, "/api/list");
    assert.match(String(error), /BAIDU_NETDISK_RISK_CONTROL/);
    assert.match(String(error), /request_id=trace-123/);
    assert.doesNotMatch(String(error), /secret/);
  }
  gate.observe(baiduApiError({ errno: 8001 }, "/api/list"));
  await assert.rejects(gate.acquire(), /BAIDU_NETDISK_RISK_CONTROL/);
  assert.equal(baiduApiError({ errno: 0 }, "/api/list"), undefined);
});

test("filemanager 132 blocks that operation without opening the global upload circuit", async () => {
  const error = baiduApiError({ errno: 132, request_id: "99423870080723870" }, "/api/filemanager");
  const message = String(error);
  assert.match(message, /BAIDU_NETDISK_IDENTITY_VERIFICATION.*errno=132.*request_id=99423870080723870/);
  assert.doesNotMatch(message, /BAIDU_NETDISK_RISK_CONTROL/);
  assert.match(message, /验证身份.*删除或管理文件/);
  assert.match(message, /不会自动重试/);
  const gate = createBaiduRequestGate(0);
  gate.observe(error);
  await gate.acquire();
  gate.observe(baiduApiError({ errno: 8001 }, "/api/list"));
  gate.observe(error);
  await assert.rejects(gate.acquire(), /BAIDU_NETDISK_RISK_CONTROL/, "132 does not clear an unrelated risk circuit");
});

test("concurrent metadata calls reserve different slots and cancellation prevents dispatch", async () => {
  const gate = createBaiduRequestGate(30);
  const starts: number[] = [];
  await Promise.all([1, 2, 3].map(async () => { await gate.acquire(); starts.push(Date.now()); }));
  assert.ok(starts[2] - starts[0] >= 45);
  const controller = new AbortController();
  const pending = gate.acquire(controller.signal);
  controller.abort(new Error("用户停止"));
  await assert.rejects(pending, /用户停止/);
});

test("data transfers have their own pacing but still obey the shared risk circuit", async () => {
  const gate = createBaiduRequestGate(80, 1000, 0);
  await gate.acquire();
  let metadataStarted = false;
  const metadata = gate.acquire().then(() => { metadataStarted = true; });
  await gate.acquire(undefined, "data");
  assert.equal(metadataStarted, false, "a data transfer does not wait behind metadata slots");
  await metadata;
  gate.observe(baiduApiError({ errno: 8001 }, "/api/list"));
  await assert.rejects(gate.acquire(undefined, "data"), /BAIDU_NETDISK_RISK_CONTROL/);
  await assert.rejects(gate.acquire(), /BAIDU_NETDISK_RISK_CONTROL/);
});
