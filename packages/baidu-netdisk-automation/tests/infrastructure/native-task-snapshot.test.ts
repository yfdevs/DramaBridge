import assert from "node:assert/strict";
import test from "node:test";
import { compileFunction, createContext, runInNewContext } from "node:vm";
import {
  baiduNativeTaskSnapshotExpression,
  isMissingBaiduRemoteObject,
} from "../../src/infrastructure/native-task-snapshot.js";
import { decodeNativeDownloadTasks } from "../../src/infrastructure/native-download-status.js";
import { decodeNativeDownloadHistory } from "../../src/infrastructure/native-download-history.js";

function execute(kind: "tasks" | "history", app: object, timeout = false) {
  const context = createContext({
    setTimeout: timeout
      ? (callback: () => void) => {
          queueMicrotask(callback);
          return 1;
        }
      : setTimeout,
    clearTimeout,
  });
  const remote = {
    get app() {
      throw new Error("renderer must not touch a remote task object");
    },
    require(name: string) {
      if (name === "electron") return { app };
      if (name === "vm")
        return {
          compileFunction: (code: string, parameters: string[]) =>
            compileFunction(code, parameters, { parsingContext: context }),
        };
      throw new Error(name);
    },
  };
  return runInNewContext(baiduNativeTaskSnapshotExpression(kind), { require: () => remote });
}

test("main-process snapshots serialize callback objects before their remote lifetime expires", async () => {
  let live = true;
  const items = {
    get tasks() {
      if (!live) throw new Error("Cannot get property 'tasks' on missing remote object 13710");
      return [{ id: 10n, name: "第10集.mp4", size: 100, finish_size: 20 }];
    },
  };
  let reads = 0;
  const snapshot = await execute("tasks", {
    $downloader: {
      getDownloadTasks(callback: Function, id: number, limit: number, cid: string) {
        reads++;
        assert.deepEqual([id, limit, cid], [0, 1000, "0"]);
        callback(0, 0n, items, 1);
        live = false;
      },
    },
  });
  assert.equal(reads, 1);
  assert.throws(() => items.tasks, /missing remote object/);
  assert.equal(decodeNativeDownloadTasks(snapshot)[0].name, "第10集.mp4");
  assert.equal(decodeNativeDownloadTasks(snapshot)[0].id, "10");
});

test("history snapshots preserve the verified native signature and plain JSON records", async () => {
  const snapshot = await execute("history", {
    $getHistoryRecord(
      id: string,
      callback: Function,
      type: number,
      cid: string,
      last: number,
      limit: number,
    ) {
      assert.deepEqual([id, type, cid, last, limit], ["", 2, "0", 0, 200]);
      callback(
        0,
        0,
        JSON.stringify({
          history_items: [{ is_download: "1", trans_id: "10", local_path: "D:/本剧/第10集.mp4" }],
        }),
        1,
      );
    },
  });
  assert.equal(decodeNativeDownloadHistory(snapshot)[0].name, "第10集.mp4");
});

test("timeouts, native exceptions and unserializable data stay unknown instead of becoming an empty list", async () => {
  await assert.rejects(
    execute("tasks", { $downloader: { getDownloadTasks() {} } }, true),
    /快照读取超时/,
  );
  await assert.rejects(
    execute("tasks", {
      $downloader: {
        getDownloadTasks() {
          throw new Error("native read failed");
        },
      },
    }),
    /native read failed/,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.tasks = cyclic;
  await assert.rejects(
    execute("tasks", {
      $downloader: {
        getDownloadTasks(callback: Function) {
          callback(0, 0, cyclic, 1);
        },
      },
    }),
    /快照序列化失败/,
  );
  assert.equal(
    isMissingBaiduRemoteObject("Error: Cannot get property 'tasks' on missing remote object 13710"),
    true,
  );
  assert.equal(isMissingBaiduRemoteObject("native timeout"), false);
});
