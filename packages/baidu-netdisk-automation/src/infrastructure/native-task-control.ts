import type { NativeTask } from "./native-download-status.js";

/** Serialized into the client page. Scope-wide control is only for a caller-
 * validated disposable directory, and must never degrade to name-only matching.
 */
export function selectNativeTasksForControl(list: NativeTask[], options: {
  targetName: string;
  expectedDownloadRoot?: string;
  matchAllInDownloadRoot?: boolean;
}) {
  const helpers = {
    normalize(value: unknown) { return String(value || "").replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase(); },
  };
  const root = helpers.normalize(options.expectedDownloadRoot);
  if (options.matchAllInDownloadRoot && (!/^(?:[a-z]:\\.+|\\\\[^\\]+\\[^\\]+\\.+)/i.test(root)
    || root.split("\\").some(part => part === "." || part === ".."))) {
    throw new Error("批量下载任务操作必须指定独立的完整下载目录");
  }
  if (!options.matchAllInDownloadRoot && !options.targetName.trim()) throw new Error("下载任务名称不能为空");
  return list.filter(task => {
    const local = helpers.normalize(task.local_path);
    if (root && local !== root && !local.startsWith(root + "\\")) return false;
    return options.matchAllInDownloadRoot || String(task.name || task.server_path || "").includes(options.targetName);
  });
}

/** Verified client wrappers accept an ID array and cid, not one scalar ID. */
export async function invokeNativeTaskControl(
  downloader: Record<string, unknown>,
  action: "pause" | "resume" | "delete",
  tasks: NativeTask[],
) {
  const methods = { pause: "pauseTask", resume: "enqueueTask", delete: "deleteTask" };
  const method = methods[action];
  if (typeof downloader[method] !== "function") throw new Error("百度网盘当前版本不支持该操作：" + method);
  if (tasks.some(task => task.id === undefined || task.id === null || task.id === ""))
    throw new Error("下载任务缺少任务 ID，已停止任务操作");
  await (downloader[method] as (ids: unknown[], cid: string) => unknown).call(downloader, tasks.map(task => task.id), "0");
}

/** Native mutation returns only submission; disappearance from the active queue
 * must be confirmed before the caller removes local files.
 */
export async function confirmNativeTasksDeleted(ids: unknown[], runtime: {
  read: () => Promise<NativeTask[]>;
  wait: (milliseconds: number) => Promise<unknown>;
}) {
  const wanted = new Set(ids.map(id => String(id)));
  for (const milliseconds of [200, 500, 1000]) {
    await runtime.wait(milliseconds);
    const remaining = await runtime.read();
    if (!remaining.some(task => wanted.has(String(task.id)))) return;
  }
  throw new Error("客户端尚未确认下载任务停止，已保留本地临时文件，请稍后重试");
}
