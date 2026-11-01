import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { decodeNativeDownloadHistory } from "../../src/infrastructure/native-download-history.js";
import { selectNativeDownloadStatus } from "../../src/infrastructure/native-download-status.js";

test("history fallback is limited to download records and scoped to the correct local task", () => {
  const payload = { errorNo: 0, json: JSON.stringify({ history_items: [
    { trans_id: "done", is_download: "1", local_path: "D:/本剧/第31集.mp4" },
    { trans_id: "upload", is_download: "0", local_path: "D:/本剧/第31集.mp4" },
    { trans_id: "other", is_download: "1", local_path: "D:/别的剧/第31集.mp4" },
  ] }) };
  const decode = runInNewContext(`(${decodeNativeDownloadHistory.toString()})`) as typeof decodeNativeDownloadHistory;
  const records = decode(payload);
  assert.equal(records.length, 2);
  const result = selectNativeDownloadStatus(records, { targetName: "第31集.mp4", expectedDownloadRoot: "D:/本剧" });
  assert.equal(result.matched?.id, "done");
  assert.equal(result.matched?.completed, false);
});

test("unavailable history cannot be interpreted as confirmed task absence", () => {
  assert.throws(() => decodeNativeDownloadHistory(undefined), /不能确认任务缺失/);
  assert.throws(() => decodeNativeDownloadHistory({ errorNo: 1, json: "{}" }), /不能确认任务缺失/);
  assert.throws(() => decodeNativeDownloadHistory({ errorNo: 0, json: "invalid json" }), /格式不可用/);
  assert.deepEqual(decodeNativeDownloadHistory({ errorNo: 0, json: '{"history_items":[]}' }), []);
});
