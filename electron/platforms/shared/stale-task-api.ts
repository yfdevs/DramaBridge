import type { WatchedTaskIdentity } from "@dramabridge/automation-logging";

export type CleanupPlatform = "wechat-drama" | "taobao-drama" | "kuaishou-drama";
export type RemoteCleanupTask = {
  id: number; status?: string; rpaStatus?: string; rpaWorkerId?: string;
  rpaAttemptCount?: number; rpaClaimTime?: string; updateTime?: string;
  accountId?: string; videoAccountId?: string;
};
export type CleanupPageResponse = { code: number; msg?: string; data?: { total?: number; data?: RemoteCleanupTask[] } };

export function remoteProgressTime(task: RemoteCleanupTask) {
  const claimedAt = Date.parse(task.rpaClaimTime ?? "");
  const updatedAt = Date.parse(task.updateTime ?? "");
  if (!Number.isFinite(claimedAt)) return;
  return Math.max(claimedAt, Number.isFinite(updatedAt) ? updatedAt : claimedAt);
}

export async function discoverGlobalCleanupTasks(
  platform: CleanupPlatform,
  baseUrl: string,
  post: (endpoint: string, body: Record<string, unknown>) => Promise<CleanupPageResponse>,
  observe: (identity: WatchedTaskIdentity, lastProgressAt: number) => void,
) {
  const prefix = platform === "wechat-drama" ? "/dramaAiRpa" : `/dramaAiRpa/${platform.split("-")[0]}`;
  const tasks: RemoteCleanupTask[] = [];
  // Collect all pages before reporting can change the list's page boundaries.
  for (let page = 1; ; page++) {
    const result = await post(`${prefix}/accountTask/page`, {
      page, pageSize: 100, [platform === "wechat-drama" ? "rpaStatus" : "status"]: "UPLOADING",
    });
    if (result.code !== 0) throw new Error(result.msg || "任务列表查询失败");
    const rows = result.data?.data;
    if (!Array.isArray(rows)) throw new Error("任务列表响应无效");
    tasks.push(...rows);
    if (rows.length < 100 || page * 100 >= (result.data?.total ?? Infinity)) break;
  }
  for (const task of tasks) {
    const pending = (platform === "wechat-drama" ? task.rpaStatus : task.status) === "UPLOADING";
    const accountId = platform === "wechat-drama" ? task.videoAccountId : task.accountId;
    const lastProgressAt = remoteProgressTime(task);
    if (!pending || !accountId || !task.rpaWorkerId || !Number.isInteger(task.rpaAttemptCount)
      || task.rpaAttemptCount! < 1 || lastProgressAt === undefined) continue;
    observe({ taskId: task.id, accountId, workerId: task.rpaWorkerId,
      attemptCount: task.rpaAttemptCount!, apiBaseUrl: baseUrl,
    }, lastProgressAt);
  }
}
