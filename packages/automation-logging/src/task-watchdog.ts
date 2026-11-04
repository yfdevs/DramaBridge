export type TaskSweepResult = { busy: boolean; inspected: number; failed: number; succeeded: number; released: number; errors: number };
export type WatchedTaskIdentity = {
  taskId: number; accountId: string; workerId: string; attemptCount: number; apiBaseUrl: string;
};
export interface TaskWatchdog {
  claimed(identity: WatchedTaskIdentity): void;
  run<T>(identity: WatchedTaskIdentity, execute: () => Promise<T>, cancel: () => Promise<void>): Promise<T>;
  progress(taskId: number, signature: string): void;
  assertActive(taskId: number, workerId?: string, attemptCount?: number): void;
}
export const STALE_TASK_ERROR = "STALE_TASK_NO_PROGRESS";
export const ghostCheckIntervalMs = 3 * 60 * 60_000;
export const ghostIdleTimeoutMs = 4 * 60 * 60_000;
export function isStaleTaskError(error: unknown) {
  return error instanceof Error && error.message.includes(STALE_TASK_ERROR);
}
export type WatchdogRecord = WatchedTaskIdentity & {
  lastProgressAt: number; state: "running" | "success" | "failed" | "expired" | "reported";
};
export type WatchdogDependencies = {
  load: () => WatchdogRecord[];
  save: (records: WatchdogRecord[]) => void;
  apiBaseUrl: () => string;
  inspect: (identity: WatchedTaskIdentity) => Promise<{ owned: boolean; pending: boolean } | undefined>;
  report: (identity: WatchedTaskIdentity, success: boolean) => Promise<void>;
  beforeSweep?: () => Promise<void> | void;
  onReported?: (identity: WatchedTaskIdentity, success: boolean) => void;
  onResolved?: (identity: WatchedTaskIdentity) => void;
  log?: (message: string, details?: unknown) => void;
  now?: () => number;
  schedule?: boolean;
};

export class ProgressTaskWatchdog implements TaskWatchdog {
  private entries = new Map<string, WatchdogRecord>();
  private active = new Map<string, { cancel: () => Promise<void>; reject: (error: Error) => void }>();
  private seen = new Map<string, Set<string>>();
  private sweeping = false;
  private timer?: ReturnType<typeof setInterval>;
  private now: () => number;
  constructor(private options: WatchdogDependencies) {
    this.now = options.now ?? Date.now;
    for (const entry of options.load()) this.entries.set(this.key(entry), entry);
    if (options.schedule !== false) {
      this.timer = setInterval(() => { void this.sweep(); }, ghostCheckIntervalMs);
      this.timer.unref?.();
      queueMicrotask(() => { void this.sweep(); });
    }
  }
  private key(identity: WatchedTaskIdentity) {
    return JSON.stringify([identity.apiBaseUrl.replace(/\/+$/, ""), identity.taskId, identity.workerId, identity.attemptCount]);
  }
  private save() { this.options.save([...this.entries.values()]); }
  seed(identity: WatchedTaskIdentity, updatedAt: string, success = false) {
    const key = this.key(identity);
    if (!this.entries.has(key) && Number.isFinite(Date.parse(updatedAt))) {
      this.entries.set(key, { ...identity, state: success ? "success" : "running", lastProgressAt: Date.parse(updatedAt) });
      this.save();
    }
  }
  observe(identity: WatchedTaskIdentity, lastRemoteProgressAt: number) {
    if (!Number.isFinite(lastRemoteProgressAt)) return;
    const key = this.key(identity);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { ...identity, state: "running", lastProgressAt: lastRemoteProgressAt });
      this.save();
    } else if (existing.state !== "reported" && lastRemoteProgressAt > existing.lastProgressAt) {
      existing.lastProgressAt = lastRemoteProgressAt;
      this.save();
    }
  }
  claimed(identity: WatchedTaskIdentity) {
    const key = this.key(identity);
    if (!this.entries.has(key)) { this.entries.set(key, { ...identity, lastProgressAt: this.now(), state: "running" }); this.save(); }
  }
  assertActive(taskId: number, workerId?: string, attemptCount?: number) {
    for (const value of this.entries.values()) {
      if (value.taskId === taskId && (!workerId || value.workerId === workerId) && (!attemptCount || value.attemptCount === attemptCount)
        && ["expired", "reported"].includes(value.state)) throw new Error(STALE_TASK_ERROR);
    }
  }
  progress(taskId: number, signature: string) {
    for (const [key, value] of this.entries) {
      if (value.taskId !== taskId || value.state !== "running" || !this.active.has(key)) continue;
      const signatures = this.seen.get(key) ?? new Set<string>();
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      if (signatures.size > 512) signatures.delete(signatures.values().next().value!);
      this.seen.set(key, signatures);
      const persist = this.now() - value.lastProgressAt >= 60_000;
      value.lastProgressAt = this.now();
      if (persist) this.save();
    }
  }
  async run<T>(identity: WatchedTaskIdentity, execute: () => Promise<T>, cancel: () => Promise<void>): Promise<T> {
    this.assertActive(identity.taskId, identity.workerId, identity.attemptCount);
    const key = this.key(identity);
    const record: WatchdogRecord = { ...identity, lastProgressAt: this.now(), state: "running" };
    this.entries.set(key, record); this.save();
    const expired = new Promise<never>((_resolve, reject) => { this.active.set(key, { cancel, reject }); });
    try {
      const work = Promise.resolve().then(execute).then(value => {
        this.assertActive(identity.taskId, identity.workerId, identity.attemptCount);
        record.state = "success"; this.save(); return value;
      }, error => {
        this.assertActive(identity.taskId, identity.workerId, identity.attemptCount);
        record.state = "failed"; this.save(); throw error;
      });
      return await Promise.race([work, expired]);
    } finally { this.active.delete(key); this.seen.delete(key); }
  }
  async sweep(now = this.now()): Promise<TaskSweepResult> {
    const result: TaskSweepResult = { busy: false, inspected: 0, failed: 0, succeeded: 0, released: 0, errors: 0 };
    if (this.sweeping) return { ...result, busy: true };
    this.sweeping = true;
    try {
      await this.options.beforeSweep?.();
      for (const [key, record] of this.entries) {
        if (record.state === "reported" || record.apiBaseUrl.replace(/\/+$/, "") !== this.options.apiBaseUrl().replace(/\/+$/, "")
          || now - record.lastProgressAt < ghostIdleTimeoutMs) continue;
        try {
          result.inspected++;
          const snapshot = record.lastProgressAt;
          const remote = await this.options.inspect(record);
          if (!remote || record.lastProgressAt !== snapshot || now - record.lastProgressAt < ghostIdleTimeoutMs) continue;
          if (!remote.pending || !remote.owned) {
            record.state = "expired";
            this.active.get(key)?.reject(new Error(STALE_TASK_ERROR));
            await this.active.get(key)?.cancel().catch(error => this.options.log?.("关闭过期任务页面失败，继续回写", error));
            this.options.onResolved?.(record);
            record.state = "reported"; this.save(); result.released++; continue;
          }
          const success = record.state === "success";
          if (!success) {
            record.state = "expired"; this.save();
            const active = this.active.get(key);
            active?.reject(new Error(STALE_TASK_ERROR));
            await active?.cancel().catch(error => this.options.log?.("关闭过期任务页面失败，继续回写", error));
          }
          await this.options.report(record, success);
          this.options.onReported?.(record, success);
          record.state = "reported"; this.save();
          if (success) result.succeeded++; else result.failed++;
          this.options.log?.("过期任务巡检已回写", { taskId: record.taskId, success });
        } catch (error) { result.errors++; this.options.log?.("过期任务巡检失败，保留记录下次重试", { taskId: record.taskId, error }); }
      }
    } catch (error) { result.errors++; this.options.log?.("定时巡检失败", error); }
    finally { this.sweeping = false; }
    return result;
  }
  dispose() { if (this.timer) clearInterval(this.timer); }
}
