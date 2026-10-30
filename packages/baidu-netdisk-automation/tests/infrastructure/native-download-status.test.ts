import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { decodeNativeDownloadTasks, selectNativeDownloadStatus } from "../../src/infrastructure/native-download-status.js";

test("empty client lists and JSON task lists are decoded without treating read errors as missing tasks", () => {
  assert.deepEqual(decodeNativeDownloadTasks({ errorNo: 0, items: { tasks: "" }, count: 0 }), []);
  const payload = { errorNo: 0, items: { tasks: JSON.stringify([{ name: "第31集.mp4" }]) }, count: 1 };
  assert.equal(decodeNativeDownloadTasks(payload)[0].name, "第31集.mp4");
  assert.throws(() => decodeNativeDownloadTasks({ errorNo: 1, items: { tasks: [] } }), /暂不可用/);
  assert.throws(() => decodeNativeDownloadTasks({ errorNo: 0, items: { tasks: "" }, count: 2 }), /格式不可用/);
  assert.equal(runInNewContext(`(${decodeNativeDownloadTasks.toString()})(${JSON.stringify(payload)})`)[0].name, "第31集.mp4");
});

test("individual episode tasks are matched only within their own download directory", () => {
  const list = [
    { name: "第30集.mp4", local_path: "D:/任务/本剧/第30集.mp4", size: 100, finish_size: 20, status: "downloading" },
    { name: "第31集.mp4", local_path: "D:/任务/本剧/第31集.mp4", size: 100, finish_size: 100, status: "completed" },
    { name: "第30集.mp4", local_path: "D:/别的任务/第30集.mp4", size: 999, finish_size: 999, status: "completed" },
  ];
  const options = { targetName: "本剧", targetNames: ["第30集.mp4", "第31集.mp4"], expectedDownloadRoot: "D:/任务/本剧" };
  const result = selectNativeDownloadStatus(list, options);
  assert.equal(result.matched?.size, "200");
  assert.equal(result.matched?.finishSize, "120");
  assert.equal(result.matched?.completed, false);
  assert.equal(result.matched?.localPath, options.expectedDownloadRoot);
  const serialized = runInNewContext(`(${selectNativeDownloadStatus.toString()})(${JSON.stringify(list)}, ${JSON.stringify(options)})`);
  assert.equal(serialized.matched.completed, false);
});

test("an absent parent task does not hide active episode downloads, and unscoped grouping is rejected", () => {
  const task = { name: "第31集.mp4", local_path: "D:/本剧/第31集.mp4", size: 100, finish_size: 50 };
  assert.equal(selectNativeDownloadStatus([task], { targetName: "本剧" }).matched, undefined);
  assert.ok(selectNativeDownloadStatus([task], { targetName: "本剧", targetNames: [task.name], expectedDownloadRoot: "D:/本剧" }).matched);
  assert.throws(() => selectNativeDownloadStatus([task], { targetName: "本剧", targetNames: [task.name] }), /缺少下载目录/);
});
