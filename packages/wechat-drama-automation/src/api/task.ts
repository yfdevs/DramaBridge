import { getWechatVideoRuntimeSettings } from "../shared/runtime-settings.js";
import type { TaskWatchdog } from "@dramabridge/automation-logging";
import { queueWechatTaskReport } from "./task-reports.js";
import { randomUUID } from "node:crypto";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import type { ClaimedAccountTask } from "../shared/types.js";
import type { RpaFailStage } from "../shared/errors.js";
import type { VideoAccount } from "./video-accounts.js";
import { createLogger } from "../shared/logger.js";
import { httpClient } from "./http-client.js";

export interface ClaimedTaskErrorReport {
  workerId: string;
  attemptCount: number;
  accountTaskId: number;
  dramaId?: number;
  failStage: RpaFailStage;
  resultJson?: Record<string, unknown>;
  videoAccountId: string;
  errorMessage: string;
}

export interface ClaimedTaskSuccessReport {
  workerId: string;
  attemptCount: number;
  accountTaskId: number;
}

export interface ClaimNextTaskOptions {
  excludedAccountTaskIds?: ReadonlySet<number>;
}

let taskWatchdog: TaskWatchdog | undefined;
export function configureWechatTaskWatchdog(value?: TaskWatchdog) { taskWatchdog = value; }

const logger = createLogger("task-api");

interface ClaimTaskResponse {
  code: number;
  msg: string;
  data?: {
    accountTaskId: number;
    workerId?: string;
    attemptCount?: number;
    originalTitle?: string;
    dramaId?: number;
    payloadJson?: unknown;
  } | null;
}

export interface AccountTaskPageItem {
  id: number;
  dramaId?: number;
  videoAccountId: string;
  videoAccountName?: string;
  rpaStatus?: string;
  originalTitle?: string;
}

interface AccountTaskPageResponse {
  code: number;
  msg: string;
  data?: {
    total: number;
    data: AccountTaskPageItem[];
  } | null;
}

async function findNextUnclaimedAccountTaskId(
  videoAccount: VideoAccount,
  options: ClaimNextTaskOptions = {},
): Promise<number | null> {
  const requestPayload = {
    page: 1,
    pageSize: 100,
    videoAccountId: videoAccount.id,
    rpaStatus: "READY",
  };
  const url = "/dramaAiRpa/accountTask/page";

  logger.info("account task page request", {
    url,
    videoAccountId: videoAccount.id,
    videoAccountName: videoAccount.name,
    page: requestPayload.page,
    pageSize: requestPayload.pageSize,
    rpaStatus: requestPayload.rpaStatus,
  });
  const payload = await httpClient.post<AccountTaskPageResponse>(url, requestPayload);
  if (payload.code !== 0) {
    throw new Error(`Failed to query account task page: ${payload.msg || `code=${payload.code}`}`);
  }

  const total = payload.data?.total ?? 0;
  const items = payload.data?.data ?? [];
  const statusSummary = items.reduce<Record<string, number>>((summary, item) => {
    const status = item.rpaStatus ?? "UNKNOWN";
    summary[status] = (summary[status] ?? 0) + 1;
    return summary;
  }, {});
  logger.info("account task page response", {
    videoAccountId: videoAccount.id,
    total,
    rows: items.length,
    statusSummary,
  });

  const excludedAccountTaskIds = options.excludedAccountTaskIds;
  const skippedItems = excludedAccountTaskIds
    ? items.filter((item) => excludedAccountTaskIds.has(item.id))
    : [];
  if (skippedItems.length > 0) {
    logger.info("skip cooling account tasks", {
      videoAccountId: videoAccount.id,
      accountTaskIds: skippedItems.map((item) => item.id),
    });
  }

  const accountTask = items.find((item) => !excludedAccountTaskIds?.has(item.id)) ?? null;
  if (!accountTask) {
    logger.info("no claimable account task", {
      videoAccountId: videoAccount.id,
      videoAccountName: videoAccount.name,
      rpaStatus: "READY",
    });
    return null;
  }

  logger.info("selected account task", {
    accountTaskId: accountTask.id,
    rpaStatus: accountTask.rpaStatus,
    originalTitle: accountTask.originalTitle,
    videoAccountId: videoAccount.id,
  });
  return accountTask.id;
}

export async function claimNextTaskForVideoAccountApi(
  videoAccount: VideoAccount,
  options: ClaimNextTaskOptions = {},
): Promise<ClaimedAccountTask | null> {
  const accountTaskId = await findNextUnclaimedAccountTaskId(videoAccount, options);
  if (!accountTaskId) return null;

  const url = "/dramaAiRpa/rpa/claim";
  logger.info("claim request", {
    url,
    accountTaskId,
    videoAccountId: videoAccount.id,
  });
  const workerId = randomUUID();
  const payload = await httpClient.post<ClaimTaskResponse>(url, {
    workerId,
    accountTaskId,
  });
  logger.info("claim response", {
    accountTaskId,
    code: payload.code,
    responseMessage: payload.msg,
  });
  if (payload.code !== 0) {
    throw new Error(`Failed to claim task: ${payload.msg || `code=${payload.code}`}`);
  }
  if (!payload.data) {
    return null;
  }
  if (!payload.data.accountTaskId || !payload.data.originalTitle || !payload.data.payloadJson) {
    throw new Error(
      "Claim task response data.accountTaskId, data.originalTitle and data.payloadJson are required.",
    );
  }

  if (payload.data.accountTaskId !== accountTaskId || payload.data.workerId !== workerId
    || !Number.isInteger(payload.data.attemptCount) || payload.data.attemptCount! < 1) {
    throw new Error("WECHAT_DRAMA_CLAIM_IDENTITY_INVALID: 领取响应的任务、执行标识或轮次不匹配，已停止执行");
  }
  const playlet =
    typeof payload.data.payloadJson === "string"
      ? (JSON.parse(payload.data.payloadJson) as Record<string, unknown>)
      : payload.data.payloadJson;
  if (typeof playlet !== "object" || playlet === null || Array.isArray(playlet)) {
    throw new Error("Claim task response data.payloadJson must be a JSON object.");
  }

  const task: ClaimedAccountTask = {
    workerId,
    attemptCount: payload.data.attemptCount!,
    accountTaskId: payload.data.accountTaskId,
    originalTitle: payload.data.originalTitle,
    dramaId: payload.data.dramaId,
    videoAccountId: videoAccount.id,
    videoAccountName: videoAccount.name,
    playlet: playlet as Record<string, unknown>,
  };
  taskWatchdog?.claimed({ taskId: task.accountTaskId, accountId: videoAccount.id, workerId: task.workerId, attemptCount: task.attemptCount, apiBaseUrl: getWechatVideoRuntimeSettings().apiBaseUrl });
  logger.info("claimed account task", {
    accountTaskId: task.accountTaskId,
    dramaId: task.dramaId,
    originalTitle: task.originalTitle,
    videoAccountId: task.videoAccountId,
    videoAccountName: task.videoAccountName,
  });
  return task;
}

export async function reportClaimedTaskSuccessApi(
  successReport: ClaimedTaskSuccessReport,
): Promise<void> {
  const url = "/dramaAiRpa/rpa/report";
  const requestPayload = {
    accountTaskId: successReport.accountTaskId,
    workerId: successReport.workerId,
    attemptCount: successReport.attemptCount,
    rpaStatus: "SUCCESS",
  };
  logger.info("success callback request", {
    url,
    accountTaskId: successReport.accountTaskId,
  });
  await queueWechatTaskReport(requestPayload);

  logger.info("success result queued", {
    accountTaskId: successReport.accountTaskId,
  });
}

export async function reportClaimedTaskErrorApi(
  errorReport: ClaimedTaskErrorReport,
): Promise<void> {
  if (isBrowserClosedError(errorReport.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(errorReport.errorMessage, {
    fallbackMessage: "微信视频号任务提交失败，未获取到具体错误原因",
  });
  const url = "/dramaAiRpa/rpa/report";
  const requestPayload = {
    accountTaskId: errorReport.accountTaskId,
    workerId: errorReport.workerId,
    attemptCount: errorReport.attemptCount,
    rpaStatus: "FAILED",
    failStage: errorReport.failStage,
    resultJson: errorReport.resultJson ?? {},
    errorMessage,
  };
  logger.info("fail callback request", {
    url,
    accountTaskId: errorReport.accountTaskId,
    dramaId: errorReport.dramaId,
    failStage: errorReport.failStage,
    videoAccountId: errorReport.videoAccountId,
    errorMessage,
    resultJson: requestPayload.resultJson,
  });
  await queueWechatTaskReport(requestPayload);

  logger.info("failure result queued", {
    accountTaskId: errorReport.accountTaskId,
    workerId: errorReport.workerId,
    attemptCount: errorReport.attemptCount,
    rpaStatus: "FAILED",
    failStage: errorReport.failStage,
  });
}
