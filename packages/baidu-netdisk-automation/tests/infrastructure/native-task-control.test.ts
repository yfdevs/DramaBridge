import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { confirmNativeTasksDeleted, invokeNativeTaskControl, selectNativeTasksForControl } from "../../src/infrastructure/native-task-control.js";

test("scoped cleanup includes all individual episodes and materials but excludes sibling roots", () => {
  const list = [
    { id: 1, name: "1.mp4", local_path: "D:/下载/本剧__hash/正片/1.mp4" },
    { id: 2, name: "2.mp4", local_path: "D:/下载/本剧__hash/正片/2.mp4" },
    { id: 3, name: "海报", local_path: "D:/下载/本剧__hash/材料" },
    { id: 4, name: "1.mp4", local_path: "D:/下载/本剧__hash-copy/正片/1.mp4" },
  ];
  const options = { targetName: "本剧", expectedDownloadRoot: "D:/下载/本剧__hash", matchAllInDownloadRoot: true };
  assert.deepEqual(selectNativeTasksForControl(list, options).map(task => task.id), [1, 2, 3]);
  const serialized = runInNewContext(`(${selectNativeTasksForControl.toString()})(${JSON.stringify(list)}, ${JSON.stringify(options)})`);
  assert.equal(serialized.length, 3);
});

test("scope-wide operations never fall back to a broad name match", () => {
  for (const root of [undefined, "", "D:/", "../任务", "D:/下载/../任务"])
    assert.throws(() => selectNativeTasksForControl([], {
      targetName: "本剧", expectedDownloadRoot: root, matchAllInDownloadRoot: true,
    }), /完整下载目录/);
});

test("ordinary named task controls keep their name and root filter", () => {
  const list = [
    { id: 1, name: "正片", local_path: "D:/本剧/正片" },
    { id: 2, name: "海报", local_path: "D:/本剧/海报" },
    { id: 3, name: "正片", local_path: "D:/别的剧/正片" },
  ];
  assert.deepEqual(selectNativeTasksForControl(list, { targetName: "正片", expectedDownloadRoot: "D:/本剧" }).map(task => task.id), [1]);
});

test("verified native controls receive an ID array and channel, including enqueueTask for resume", async () => {
  const invoke = runInNewContext(`(${invokeNativeTaskControl.toString()})`) as typeof invokeNativeTaskControl;
  for (const [action, expected] of [["pause", "pauseTask"], ["resume", "enqueueTask"], ["delete", "deleteTask"]] as const) {
    const calls: Array<{ method: string; ids: unknown[]; cid: string }> = [];
    const downloader = Object.fromEntries(["pauseTask", "enqueueTask", "deleteTask"].map(method => [method,
      (ids: unknown[], cid: string) => calls.push({ method, ids: Array.from(ids), cid }),
    ]));
    await invoke(downloader, action, [{ id: "one" }, { id: "two" }]);
    assert.deepEqual(calls, [{ method: expected, ids: ["one", "two"], cid: "0" }]);
  }
});

test("missing IDs or unsupported native controls fail without trying guessed methods", async () => {
  let mutated = false;
  await assert.rejects(invokeNativeTaskControl({ deleteTask: () => { mutated = true; } }, "delete", [{}]), /缺少任务 ID/);
  await assert.rejects(invokeNativeTaskControl({ removeTask: () => { mutated = true; } }, "delete", [{ id: 1 }]), /不支持/);
  assert.equal(mutated, false);
});

test("local cleanup waits for deletion acknowledgment in the active queue", async () => {
  let polls = 0;
  const confirm = runInNewContext(`(${confirmNativeTasksDeleted.toString()})`) as typeof confirmNativeTasksDeleted;
  await confirm(["one"], {
    read: async () => ++polls === 1 ? [{ id: "one" }] : [{ id: "other task" }],
    wait: async () => {},
  });
  assert.equal(polls, 2);
  await assert.rejects(confirm(["one"], {
    read: async () => [{ id: "one" }], wait: async () => {},
  }), /保留本地临时文件/);
  await assert.rejects(confirm(["one"], {
    read: async () => { throw new Error("读取失败"); }, wait: async () => {},
  }), /读取失败/);
});
