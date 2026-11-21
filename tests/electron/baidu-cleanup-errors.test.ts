import assert from "node:assert/strict";
import test from "node:test";
import { describeCleanupPause } from "../../electron/platforms/baidu-netdisk/cleanup-errors";

const raw = "执行网盘脚本：Error: [BAIDU_NETDISK_IDENTITY_VERIFICATION] 百度网盘要求验证身份。errno=132 endpoint=/api/filemanager request_id=492835836123741760\n at requestOnce (<anonymous>:102:12)";
test("legacy persisted identity errors show recovery text without stacks or request internals", () => {
  const result = describeCleanupPause(raw);
  assert.equal(result.pauseKind, "identity"); assert.match(result.message, /百度要求身份验证/);
  assert.doesNotMatch(result.message, /anonymous|request_id|filemanager|Error:/);
  assert.equal(describeCleanupPause("errno=132").pauseKind, "identity");
  assert.notEqual(describeCleanupPause("errno=1320").pauseKind, "identity");
});
test("new batch diagnostics remain available alongside readable error text", () => {
  const batch = { index: 3, kind: "files", count: 6, bytes: 1965958368, confirmedBatches: 2 };
  const result = describeCleanupPause(`[BAIDU_CLEANUP_BATCH] ${JSON.stringify(batch)}\n${raw}`);
  assert.deepEqual(result.batch, batch); assert.equal(result.pauseKind, "identity");
  assert.equal(describeCleanupPause('[BAIDU_CLEANUP_BATCH] {broken}\n' + raw).pauseKind, "identity");
  assert.equal(describeCleanupPause('[BAIDU_CLEANUP_BATCH] {"index":-1}\n' + raw).batch, undefined);
});
test("risk, capacity and unknown failures retain distinct recovery messages", () => {
  assert.equal(describeCleanupPause("BAIDU_NETDISK_RISK_CONTROL").pauseKind, "risk");
  assert.equal(describeCleanupPause("删除后容量尚未下降").pauseKind, "capacity");
  assert.equal(describeCleanupPause("目录身份已变化").message, "目录身份已变化");
  assert.doesNotMatch(describeCleanupPause("执行网盘脚本：Error: unknown at async remove (<anonymous>:1:1)").message, /anonymous/);
});
