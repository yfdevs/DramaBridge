import type { LocalApiHandler } from "../../local-api/http-server";
import {
  ExternalApiError,
  type ExternalDownloads,
  type ExternalDownloadTask,
} from "./external-downloads";

export function publicExternalDownloadTask(task: ExternalDownloadTask) {
  return {
    taskId: task.taskId,
    attempt: task.attempt,
    requestId: task.request.requestId,
    resourceName: task.request.resourceName,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    deadlineAt: task.deadlineAt,
    timeoutSeconds: task.request.timeoutSeconds,
    result: task.result,
    error: task.error,
    callback: task.callback,
  };
}

export async function postExternalDownloadCallback(task: ExternalDownloadTask) {
  const event = {
    eventId: `${task.taskId}:${task.attempt}`,
    event: `download.${task.status}`,
    ...publicExternalDownloadTask(task),
  };
  const body = JSON.stringify(event);
  const response = await fetch(task.request.callbackUrl!, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`回调返回 HTTP ${response.status}`);
}

export function createExternalDownloadRoutes(options: {
  manager: () => ExternalDownloads;
  status: () => Promise<unknown>;
  start: () => Promise<unknown>;
  control: (task: ExternalDownloadTask, action: "pause" | "resume") => Promise<unknown>;
  progress: (task: ExternalDownloadTask) => unknown;
}): LocalApiHandler {
  const { manager } = options;
  const publicTask = publicExternalDownloadTask;
  return async ({ method, url, body, signal }) => {
    if (method === "GET" && url.pathname === "/api/health")
      return { data: { service: "dramabridge", version: 1 } };
    if (method === "GET" && url.pathname === "/api/baidu-netdisk/status")
      return { data: await options.status() };
    if (method === "POST" && url.pathname === "/api/baidu-netdisk/start")
      return { data: await options.start() };
    const prefix = "/api/baidu-netdisk/downloads";
    if (method === "GET" && url.pathname === prefix)
      return { data: manager().store.list().slice(0, 100).map(publicTask) };
    if (method === "POST" && url.pathname === prefix) {
      const submitted = manager().submit(body);
      if (url.searchParams.get("wait") !== "true")
        return { status: submitted.created ? 202 : 200, data: publicTask(submitted.task) };
      const task = await manager().wait(submitted.task.taskId, signal);
      return {
        status: task.status === "completed" ? 200 : task.status === "timed_out" ? 504 : 422,
        data: publicTask(task),
      };
    }
    const match = /^\/api\/baidu-netdisk\/downloads\/([\w-]+)(?:\/(retry|pause|resume))?$/u.exec(
      url.pathname,
    );
    if (match) {
      const taskId = match[1]!;
      if (method === "GET" && !match[2]) {
        const task = manager().get(taskId);
        return {
          data: {
            ...publicTask(task),
          progress: task.status === "running" ? options.progress(task) : undefined,
          },
        };
      }
      if (method === "POST" && match[2] === "retry")
        return { status: 202, data: publicTask(manager().retry(taskId)) };
      if (method === "POST" && (match[2] === "pause" || match[2] === "resume")) {
        const task = manager().get(taskId);
        if (task.status !== "running")
          throw new ExternalApiError(409, "TASK_NOT_RUNNING", "任务未在运行，不能暂停或恢复");
        return { data: await options.control(task, match[2]) };
      }
    }
    throw new ExternalApiError(404, "NOT_FOUND", "接口不存在");
  };
}
