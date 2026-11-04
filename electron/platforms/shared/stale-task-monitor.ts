import { discoverGlobalCleanupTasks, remoteProgressTime, type RemoteCleanupTask } from "./stale-task-api";
import { ProgressTaskWatchdog, type WatchedTaskIdentity, type WatchdogRecord } from "@dramabridge/automation-logging";
import { createValidatedStore } from "../../core/config-store";
import { logMain } from "../../main-logger";

type Platform = "wechat-drama" | "taobao-drama" | "kuaishou-drama";
type RemoteTask = RemoteCleanupTask;
const monitors = new Map<Platform, ProgressTaskWatchdog>();
const timeoutMessage = "任务领取后连续4小时无进展，定时巡检已清理并上报失败";

async function request(baseUrl: string, endpoint: string, body: unknown) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json() as { code: number; msg?: string; data?: { total?: number; data?: RemoteTask[] } };
  if (result.code !== 0) throw new Error(result.msg || `API code=${result.code}`);
  return result;
}

export function staleTaskMonitor(platform: Platform, config: {
  apiBaseUrl: () => string;
  beforeSweep?: () => Promise<void> | void;
  onReported?: (record: WatchedTaskIdentity, success: boolean) => void;
  onResolved?: (record: WatchedTaskIdentity) => void;
}) {
  const existing = monitors.get(platform);
  if (existing) return existing;
  const store = createValidatedStore<{ tasks: WatchdogRecord[] }>({ name: `${platform}-stalled-tasks`, defaults: { tasks: [] } });
  const prefix = platform === "wechat-drama" ? "/dramaAiRpa" : `/dramaAiRpa/${platform.split("-")[0]}`;
  const monitor = new ProgressTaskWatchdog({
    ...config,
    beforeSweep: async () => {
      try { await config.beforeSweep?.(); }
      catch (error) { logMain("warn", `${platform} 本地记录恢复失败，继续扫描后台全部账号`, error); }
      const baseUrl = config.apiBaseUrl();
      await discoverGlobalCleanupTasks(platform, baseUrl,
        (endpoint, body) => request(baseUrl, endpoint, body),
        (identity, timestamp) => monitor.observe(identity, timestamp));
    },
    load: () => store.get("tasks"),
    save: records => store.set("tasks", records),
    log: (message, details) => logMain("info", `${platform} ${message}`, details),
    inspect: async record => {
      for (let page = 1; ; page++) {
        const result = await request(record.apiBaseUrl, `${prefix}/accountTask/page`, {
          page, pageSize: 100, [platform === "wechat-drama" ? "videoAccountId" : "accountId"]: record.accountId,
        });
        const rows = result.data?.data;
        if (!Array.isArray(rows)) throw new Error("任务列表响应无效");
        const task = rows.find(item => item.id === record.taskId);
        if (task) {
          const pending = (platform === "wechat-drama" ? task.rpaStatus : task.status) === "UPLOADING";
          if (pending && (!task.rpaWorkerId || !task.rpaAttemptCount)) throw new Error("任务归属字段缺失，暂停清理");
          const owned = task.rpaWorkerId === record.workerId && task.rpaAttemptCount === record.attemptCount;
          const timestamp = remoteProgressTime(task);
          if (owned && timestamp !== undefined) monitor.observe(record, timestamp);
          return { pending, owned };
        }
        if (rows.length < 100 || page * 100 >= (result.data?.total ?? Infinity)) return;
      }
    },
    report: async (record, success) => {
      await request(record.apiBaseUrl, `${prefix}/rpa/report`, platform === "wechat-drama" ? {
        accountTaskId: record.taskId, workerId: record.workerId, attemptCount: record.attemptCount,
        rpaStatus: success ? "SUCCESS" : "FAILED", ...(!success && { failStage: "OTHER", errorMessage: timeoutMessage }),
      } : {
        taskId: record.taskId, workerId: record.workerId, attemptCount: record.attemptCount,
        success, ...(!success && { failStage: "OTHER", errorMessage: timeoutMessage }),
      });
    },
  });
  monitors.set(platform, monitor);
  return monitor;
}

// Recover ownership when a claim reached the server but its response was lost.
// Only records already persisted by this installation are considered.
export async function seedUnconfirmedClaims<T extends {
  taskId: number; accountId: string; workerId: string; attemptCount?: number;
  apiBaseUrl: string; createdAt: string; phase: string; ownerProcessId?: number;
}>(platform: "taobao-drama" | "kuaishou-drama", records: T[], monitor: ProgressTaskWatchdog, save: (record: T) => void) {
  const prefix = `/dramaAiRpa/${platform.split("-")[0]}`;
  for (const record of records) {
    if (record.attemptCount || ["reported", "released", "claim-rejected"].includes(record.phase)) continue;
    if (record.ownerProcessId && record.ownerProcessId !== process.pid) {
      try { process.kill(record.ownerProcessId, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    for (let page = 1; ; page++) {
      const result = await request(record.apiBaseUrl, `${prefix}/accountTask/page`, { page, pageSize: 100, accountId: record.accountId });
      const rows = result.data?.data;
      if (!Array.isArray(rows)) throw new Error("任务列表响应无效");
      const task = rows.find(item => item.id === record.taskId);
      if (task) {
        if (task.status === "UPLOADING" && task.rpaWorkerId === record.workerId && Number.isInteger(task.rpaAttemptCount) && task.rpaAttemptCount! > 0) {
          save({ ...record, attemptCount: task.rpaAttemptCount! });
          monitor.seed({ taskId: record.taskId, accountId: record.accountId, workerId: record.workerId, apiBaseUrl: record.apiBaseUrl, attemptCount: task.rpaAttemptCount! }, task.rpaClaimTime ?? record.createdAt);
        }
        break;
      }
      if (rows.length < 100 || page * 100 >= (result.data?.total ?? Infinity)) break;
    }
  }
}
