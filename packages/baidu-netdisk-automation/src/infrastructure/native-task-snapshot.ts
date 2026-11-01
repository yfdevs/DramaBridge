// Keep callback payloads in the client's main process. Returning `items` via
// @electron/remote creates short-lived proxies; a later `.tasks` read can fail
// with "Cannot get property 'tasks' on missing remote object".
const mainSnapshotSource = `
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.stringify(error ? { ok: false, error: String(error.message || error) } : { ok: true, value },
          (_key, field) => typeof field === 'bigint' ? field.toString() : field));
      } catch (error) {
        resolve(JSON.stringify({ ok: false, error: '客户端下载任务快照序列化失败：' + String(error.message || error) }));
      }
    };
    timer = setTimeout(() => finish(new Error('客户端下载任务快照读取超时，不能确认任务缺失')), 2500);
    try {
      const app = electron.app;
      if (kind === 'tasks') {
        app.$downloader.getDownloadTasks((errorNo, flag, items, count) => {
          finish(null, { errorNo, items, count });
        }, 0, 1000, '0');
      } else {
        if (typeof app.$getHistoryRecord !== 'function') throw new Error('客户端下载历史不可用，不能确认任务缺失');
        app.$getHistoryRecord('', (errorNo, flag, json, count) => {
          finish(null, { errorNo, json, count });
        }, 2, '0', 0, 200);
      }
    } catch (error) { finish(error); }
  });
`;

/** Read-only. Only a JSON string crosses the remote boundary, never a task proxy. */
export function baiduNativeTaskSnapshotExpression(kind: "tasks" | "history") {
  return `(async () => {
    const remote = require('@electron/remote');
    const run = remote.require('vm').compileFunction(${JSON.stringify(mainSnapshotSource)}, ['electron', 'kind']);
    const electron = remote.require('electron');
    const snapshot = JSON.parse(await run(electron, ${JSON.stringify(kind)}));
    if (!snapshot.ok) throw new Error(snapshot.error);
    return snapshot.value;
  })()`;
}

export function isMissingBaiduRemoteObject(error: unknown) {
  return /missing remote object\b|remote object.*(?:released|destroyed)/i.test(String(error));
}
