/** Serialized into the client page. Keep independent of module-scope helpers. */
export async function deleteBaiduRootDirectoryInPage(
  request: <T>(url: string, init?: RequestInit, timeoutMs?: number) => Promise<T>,
  options: {
    path: string;
    fsId: string;
    targetLabel: string;
    token: string;
    pageSize: number;
    maxPages: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<{ deleted: boolean; alreadyMissing: boolean; errno?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("网盘删除及结果确认超时；请先核对实际结果后重试，不会自动重发删除")), options.timeoutMs ?? 25_000);
  const params = () => new URLSearchParams({
    channel: "chunlei", web: "1", app_id: "250528", bdstoken: options.token,
    clienttype: "0", t: String(Date.now()),
  });
  const readRootItem = async () => {
    for (let page = 1; page <= options.maxPages; page++) {
      controller.signal.throwIfAborted();
      const query = params();
      for (const [key, value] of Object.entries({ dir: "/", order: "name", desc: "0", showempty: "0", num: String(options.pageSize), page: String(page) })) query.set(key, value);
      const data = await request<{ errno?: number; list?: Array<Record<string, unknown>>; has_more?: unknown }>(
        "/api/list?" + query, { signal: controller.signal }, 10_000,
      );
      if (data.errno !== 0) throw new Error("读取网盘根目录失败：errno=" + String(data.errno));
      if (!Array.isArray(data.list)) throw new Error("网盘根目录返回无效清单，不能确认目录不存在");
      const item = data.list.find(entry => String(entry.path || "") === options.path);
      if (item) return item;
      if (data.has_more === false || data.has_more === 0 || (data.list.length < options.pageSize && !data.has_more)) return undefined;
    }
    throw new Error("网盘根目录超过安全分页上限，不能确认目录不存在：" + options.path);
  };
  try {
    const item = await readRootItem();
    if (!item) return { deleted: false, alreadyMissing: true };
    const actualFsId = String(item.fs_id || item.fsid || item.id || "");
    if (actualFsId !== options.fsId) throw new Error(options.targetLabel + " fsId 已变化，拒绝删除：expected=" + options.fsId + " actual=" + actualFsId);
    if (Number(item.isdir ?? item.is_dir ?? 0) !== 1) throw new Error(options.targetLabel + "路径不再是目录，拒绝删除：" + options.path);

    controller.signal.throwIfAborted();
    const query = params();
    query.set("opera", "delete"); query.set("async", "2"); query.set("onnest", "fail");
    const result = await request<{ errno?: number; errmsg?: string; show_msg?: string; taskid?: unknown; task_id?: unknown }>("/api/filemanager?" + query, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ filelist: JSON.stringify([options.path]) }),
    }, 10_000);
    if (result.errno !== 0) throw new Error("删除网盘" + options.targetLabel + "失败：errno=" + String(result.errno) + " message=" + String(result.errmsg || result.show_msg || ""));

    const taskId = result.taskid ?? result.task_id;
    if (taskId !== undefined && taskId !== null && String(taskId) !== "") {
      if (typeof taskId !== "string" && typeof taskId !== "number") throw new Error("网盘删除任务ID异常，不能确认结果，不会自动重发删除");
      for (let attempt = 0; attempt < 20; attempt++) {
        controller.signal.throwIfAborted();
        const progressQuery = params();
        progressQuery.set("taskid", String(taskId));
        const state = await request<{ errno?: number; status?: string; list?: Array<{ errno?: unknown; error_code?: unknown }> }>(
          "/api/taskquery?" + progressQuery, { signal: controller.signal }, 10_000,
        );
        if (state.errno !== 0) throw new Error("读取网盘删除任务失败：errno=" + String(state.errno));
        const failedItem = state.list?.find(item => Number(item.errno ?? item.error_code ?? 0) !== 0);
        if (failedItem || state.status === "failed") throw new Error("网盘删除任务失败，不能确认清理完成：errno=" + String(failedItem?.errno ?? failedItem?.error_code ?? state.errno));
        if (state.status === "success") {
          if (!await readRootItem()) return { deleted: true, alreadyMissing: false, errno: 0 };
          throw new Error("网盘删除任务返回成功，但目录仍然存在，请核对实际结果后重试：" + options.path);
        }
        if (state.status !== "running") throw new Error("网盘删除任务状态无法识别，不能确认结果，不会自动重发删除");
        await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs ?? 1000));
      }
      throw new Error("网盘删除任务尚未确认结束，请核对实际结果后重试，不会自动重发删除");
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      controller.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs ?? 500));
      if (!await readRootItem()) return { deleted: true, alreadyMissing: false, errno: 0 };
    }
    throw new Error("删除请求已提交，但" + options.targetLabel + "仍然存在：" + options.path);
  } finally {
    clearTimeout(timer);
  }
}
