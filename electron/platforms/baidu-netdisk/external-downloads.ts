import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const externalDownloadSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    shareText: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(
        (value) => /https?:\/\/pan\.baidu\.com\/s\//i.test(value),
        "请输入有效的百度网盘分享链接",
      )
      .refine(
        value => /[?&]pwd=[^&#\s]+/u.test(value) || /(?:提取码|密码|pwd)[:：\s]*[a-zA-Z0-9]{4}/u.test(value),
        "请在百度网盘分享链接中携带 pwd 参数，或在分享文本中提供提取码",
      ),
    resourceName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(
        (value) =>
          !/[<>:"/\\|?*\x00-\x1f]/u.test(value) &&
          !/[. ]$/u.test(value) &&
          !/^(?:\.|\.\.|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value),
        "资源名称不能包含路径或非法文件名",
      ),
    episodeCount: z.number().int().positive().max(10_000).optional(),
    inferEpisodeCount: z.boolean().default(false),
    downloadEpisodeVideos: z.boolean().default(true),
    downloadAssetMaterials: z.boolean().default(true),
    requiredPosterImages: z.number().int().min(0).max(100).default(0),
    timeoutSeconds: z.number().positive().max(86_400).default(3_600),
    callbackUrl: z
      .string()
      .trim()
      .url()
      .max(2_048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, "回调地址必须是有效的 HTTP 或 HTTPS 地址，且不能包含账号密码或片段")
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.downloadEpisodeVideos || value.episodeCount || value.inferEpisodeCount,
    {
      message: "下载视频时需提供 episodeCount，或设置 inferEpisodeCount=true",
    },
  );

export type ExternalDownloadRequest = z.infer<typeof externalDownloadSchema>;
export type ExternalDownloadTask = {
  taskId: string;
  attempt: number;
  request: ExternalDownloadRequest;
  fingerprint: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "interrupted";
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  result?: unknown;
  error?: { code: string; message: string };
  callback?: { status: "pending" | "delivered" | "failed"; attempts: number; error?: string };
};
export interface ExternalDownloadTaskStore {
  list(): ExternalDownloadTask[];
  get(taskId: string): ExternalDownloadTask | undefined;
  findRequest(requestId: string): ExternalDownloadTask | undefined;
  save(task: ExternalDownloadTask): void;
}

export class ExternalApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isExternalTaskActive(task: ExternalDownloadTask) {
  return task.status === "queued" || task.status === "running";
}

export class ExternalDownloads {
  private pending: string[] = [];
  private processing = false;
  private closed = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private aborters = new Map<string, AbortController>();
  private listeners = new Map<string, Set<(task: ExternalDownloadTask) => void>>();
  private notifying = new Set<string>();
  private callbackTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly store: ExternalDownloadTaskStore,
    private readonly download: (
      request: ExternalDownloadRequest,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly notify?: (task: ExternalDownloadTask) => Promise<void>,
    private readonly callbackRetryDelayMs = 1_000,
  ) {
    // An application restart cannot prove that an in-flight workflow completed.
    for (const task of store.list().filter(isExternalTaskActive)) {
      this.finish(task.taskId, "interrupted", {
        code: "APPLICATION_RESTARTED",
        message: "应用已重启，请调用重试接口重新校验并继续下载",
      });
    }
    for (const task of store.list().filter((task) => task.callback?.status === "pending"))
      void this.deliver(task.taskId);
  }

  submit(value: unknown) {
    if (this.closed) throw new ExternalApiError(503, "SERVICE_STOPPED", "服务已停止");
    const parsed = externalDownloadSchema.safeParse(value);
    if (!parsed.success)
      throw new ExternalApiError(
        400,
        "INVALID_REQUEST",
        parsed.error.issues.map((issue) => issue.message).join("；"),
      );
    const request = parsed.data;
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.store.findRequest(request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ExternalApiError(409, "REQUEST_ID_CONFLICT", "相同 requestId 的请求参数不一致");
      return { task: existing, created: false };
    }
    const now = Date.now();
    const task: ExternalDownloadTask = {
      taskId: randomUUID(),
      attempt: 1,
      request,
      fingerprint,
      status: "queued",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + request.timeoutSeconds * 1_000).toISOString(),
    };
    this.store.save(task);
    this.enqueue(task);
    return { task: this.store.get(task.taskId)!, created: true };
  }

  retry(taskId: string) {
    if (this.closed) throw new ExternalApiError(503, "SERVICE_STOPPED", "服务已停止");
    const task = this.get(taskId);
    if (isExternalTaskActive(task) || task.status === "completed") return task;
    if (this.aborters.has(taskId))
      throw new ExternalApiError(409, "TASK_STOPPING", "任务正在结束旧操作，请稍后重试");
    const now = Date.now();
    const next: ExternalDownloadTask = {
      ...task,
      attempt: task.attempt + 1,
      status: "queued",
      error: undefined,
      result: undefined,
      callback: undefined,
      updatedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + task.request.timeoutSeconds * 1_000).toISOString(),
    };
    this.store.save(next);
    this.enqueue(next);
    return this.get(taskId);
  }

  get(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new ExternalApiError(404, "TASK_NOT_FOUND", "未找到下载任务");
    return task;
  }

  async wait(taskId: string, signal?: AbortSignal): Promise<ExternalDownloadTask> {
    if (signal?.aborted) throw new ExternalApiError(503, "SERVICE_STOPPED", "接口服务已关闭");
    const current = this.get(taskId);
    if (!isExternalTaskActive(current)) return current;
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(taskId) ?? new Set();
      this.listeners.set(taskId, listeners);
      const cleanup = () => {
        listeners.delete(done);
        if (!listeners.size) this.listeners.delete(taskId);
        signal?.removeEventListener("abort", aborted);
      };
      const done = (task: ExternalDownloadTask) => {
        cleanup();
        resolve(task);
      };
      const aborted = () => {
        cleanup();
        reject(
          new ExternalApiError(
            503,
            "SERVICE_STOPPED",
            "接口服务已关闭，下载任务仍可在重新开启后查询",
          ),
        );
      };
      listeners.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  close() {
    this.closed = true;
    for (const task of this.store.list().filter(isExternalTaskActive)) {
      this.finish(task.taskId, "interrupted", {
        code: "APPLICATION_STOPPED",
        message: "应用已退出，请重试任务",
      });
      this.aborters.get(task.taskId)?.abort(new Error("APPLICATION_STOPPED"));
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.callbackTimers) clearTimeout(timer);
    this.callbackTimers.clear();
  }

  private enqueue(task: ExternalDownloadTask) {
    const timer = setTimeout(
      () => {
        const error = {
          code: "DOWNLOAD_TIMEOUT",
          message: `下载任务超过 ${task.request.timeoutSeconds} 秒，已超时（包含排队时间）`,
        };
        this.finish(task.taskId, "timed_out", error);
        this.aborters.get(task.taskId)?.abort(new Error(error.code));
      },
      Math.max(1, Date.parse(task.deadlineAt) - Date.now()),
    );
    this.timers.set(task.taskId, timer);
    this.pending.push(task.taskId);
    void this.pump();
  }

  private finish(
    taskId: string,
    status: ExternalDownloadTask["status"],
    error?: ExternalDownloadTask["error"],
    result?: unknown,
  ) {
    const task = this.store.get(taskId);
    if (!task || !isExternalTaskActive(task)) return;
    const next: ExternalDownloadTask = {
      ...task,
      status,
      error,
      result,
      updatedAt: new Date().toISOString(),
      callback: task.request.callbackUrl ? { status: "pending", attempts: 0 } : undefined,
    };
    this.store.save(next);
    clearTimeout(this.timers.get(taskId));
    this.timers.delete(taskId);
    for (const listener of [...(this.listeners.get(taskId) ?? [])]) listener(next);
    if (next.callback) void this.deliver(taskId);
  }

  private async deliver(taskId: string) {
    if (this.closed || !this.notify || this.notifying.has(taskId)) return;
    const task = this.get(taskId);
    if (task.callback?.status !== "pending") return;
    if (task.callback.attempts >= 3) {
      this.store.save({ ...task, callback: { ...task.callback, status: "failed" } });
      return;
    }
    this.notifying.add(taskId);
    const attempts = task.callback.attempts + 1;
    this.store.save({ ...task, callback: { status: "pending", attempts } });
    try {
      await this.notify(task);
      const current = this.get(taskId);
      if (current.attempt === task.attempt)
        this.store.save({ ...current, callback: { status: "delivered", attempts } });
    } catch (error) {
      const current = this.get(taskId);
      if (current.attempt !== task.attempt) return;
      this.store.save({
        ...current,
        callback: {
          status: attempts >= 3 ? "failed" : "pending",
          attempts,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (attempts < 3 && !this.closed) {
        const timer = setTimeout(() => {
          this.callbackTimers.delete(timer);
          void this.deliver(taskId);
        }, this.callbackRetryDelayMs * attempts);
        this.callbackTimers.add(timer);
      }
    } finally {
      this.notifying.delete(taskId);
      const current = this.get(taskId);
      if (current.attempt !== task.attempt && current.callback?.status === "pending")
        void this.deliver(taskId);
    }
  }

  private async pump() {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      while (this.pending.length && !this.closed) {
        const taskId = this.pending.shift()!;
        const task = this.get(taskId);
        if (!isExternalTaskActive(task)) continue;
        if (Date.now() >= Date.parse(task.deadlineAt)) {
          this.finish(taskId, "timed_out", { code: "DOWNLOAD_TIMEOUT", message: "任务排队已超时" });
          continue;
        }
        const aborter = new AbortController();
        this.aborters.set(taskId, aborter);
        this.store.save({ ...task, status: "running", updatedAt: new Date().toISOString() });
        try {
          const result = await this.download(task.request, aborter.signal);
          if (Date.now() >= Date.parse(task.deadlineAt)) {
            this.finish(taskId, "timed_out", {
              code: "DOWNLOAD_TIMEOUT",
              message: "下载任务已超时",
            });
          } else this.finish(taskId, "completed", undefined, result);
        } catch (error) {
          const timedOut = Date.now() >= Date.parse(task.deadlineAt);
          this.finish(taskId, timedOut ? "timed_out" : "failed", {
            code: timedOut ? "DOWNLOAD_TIMEOUT" : "DOWNLOAD_FAILED",
            message: timedOut
              ? "下载任务已超时"
              : error instanceof Error
                ? error.message
                : String(error),
          });
        } finally {
          this.aborters.delete(taskId);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
