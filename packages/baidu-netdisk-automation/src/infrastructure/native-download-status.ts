type NativeTask = {
  id?: unknown; name?: unknown; server_path?: unknown; local_path?: unknown;
  status?: unknown; size?: unknown; finish_size?: unknown; rate?: unknown;
};

/** Client versions return an array, JSON text, or an empty string with count=0. */
export function decodeNativeDownloadTasks(payload: { errorNo?: unknown; items?: { tasks?: unknown }; count?: unknown } | undefined): NativeTask[] {
  if (!payload || Number(payload.errorNo) !== 0) throw new Error("客户端下载任务列表暂不可用");
  let tasks = payload.items?.tasks;
  if (typeof tasks === "string") {
    if (!tasks.trim() && Number(payload.count) === 0) return [];
    try { tasks = JSON.parse(tasks); } catch { throw new Error("客户端下载任务列表格式不可用"); }
  }
  if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task !== "object")) throw new Error("客户端下载任务列表格式不可用");
  return tasks;
}

/** Serialized into the client page; keep dependencies inside this function. */
export function selectNativeDownloadStatus(list: NativeTask[], options: {
  targetName: string; expectedServerPath?: string; expectedDownloadRoot?: string; targetNames?: string[];
}) {
  const helpers = {
    normalized(value: unknown) { return String(value || "").replace(/\s+/g, " ").trim(); },
    nameFromPath(value: unknown) { return String(value || "").split(/[\\/]/).filter(Boolean).pop() || ""; },
    normalizeServerPath(value: unknown) { return "/" + String(value || "").split("/").filter(Boolean).join("/"); },
    normalizeLocalPath(value: unknown) { return String(value || "").replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase(); },
    complete(task: NativeTask) {
      const size = Number(task.size), finished = Number(task.finish_size);
      return (size > 0 && finished === size) || /完成|success|finished|complete|done|已下载/i.test(String(task.status || ""));
    },
  };
  const grouped = Boolean(options.targetNames?.length);
  if (grouped && !options.expectedDownloadRoot) throw new Error("逐集下载状态检查缺少下载目录");
  const names = new Set((options.targetNames?.length ? options.targetNames : [options.targetName]).map(helpers.normalized));
  const matches = list.filter(task => {
    if (![task.name, helpers.nameFromPath(task.server_path), helpers.nameFromPath(task.local_path)].some(name => names.has(helpers.normalized(name)))) return false;
    if (options.expectedServerPath && helpers.normalizeServerPath(task.server_path) !== helpers.normalizeServerPath(options.expectedServerPath)) return false;
    if (options.expectedDownloadRoot) {
      const local = helpers.normalizeLocalPath(task.local_path), root = helpers.normalizeLocalPath(options.expectedDownloadRoot);
      if (local !== root && !local.startsWith(root + "\\")) return false;
    }
    return true;
  });
  const matched = matches[0];
  return {
    matched: matched ? {
      id: String(matched.id || ""),
      name: grouped ? options.targetName : String(matched.name || ""),
      serverPath: String(matched.server_path || ""),
      localPath: grouped ? options.expectedDownloadRoot : String(matched.local_path || ""),
      status: grouped ? `${matches.filter(helpers.complete).length}/${matches.length}个单集任务完成` : String(matched.status || ""),
      size: grouped ? String(matches.reduce((sum, task) => sum + (Number(task.size) || 0), 0)) : String(matched.size || ""),
      finishSize: grouped ? String(matches.reduce((sum, task) => sum + (Number(task.finish_size) || 0), 0)) : String(matched.finish_size || ""),
      rate: String(matches.find(task => !helpers.complete(task))?.rate || matched.rate || ""),
      completed: grouped ? matches.every(helpers.complete) : helpers.complete(matched),
    } : undefined,
    tasks: list.map(task => [task.name, task.status, `${task.finish_size}/${task.size}`, task.rate, task.server_path, task.local_path].map(helpers.normalized).filter(Boolean).join(" ")),
  };
}
