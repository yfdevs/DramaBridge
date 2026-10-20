import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import type { ClaimedAccountTask } from "../shared/types.js";
import type { RpaFailStage } from "../shared/errors.js";
import type { VideoAccount } from "./video-accounts.js";
import { createLogger } from "../shared/logger.js";
import { httpClient } from "./http-client.js";

export interface ClaimedTaskErrorReport {
  accountTaskId: number;
  dramaId?: number;
  failStage: RpaFailStage;
  resultJson?: Record<string, unknown>;
  videoAccountId: string;
  errorMessage: string;
}

export interface ClaimedTaskSuccessReport {
  accountTaskId: number;
}

export interface ClaimNextTaskOptions {
  excludedAccountTaskIds?: ReadonlySet<number>;
}

const logger = createLogger("task-api");

interface ClaimTaskResponse {
  code: number;
  msg: string;
  data?: {
    accountTaskId: number;
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

interface TaskCallbackResponse {
  code?: number;
  msg?: string;
}

function assertTaskApiResponseOk(payload: TaskCallbackResponse, action: string): void {
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(`${action} failed: ${payload.msg || `code=${payload.code}`}`);
  }
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
  const payload = await httpClient.post<ClaimTaskResponse>(url, {
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

  const playlet =
    typeof payload.data.payloadJson === "string"
      ? (JSON.parse(payload.data.payloadJson) as Record<string, unknown>)
      : payload.data.payloadJson;
  if (typeof playlet !== "object" || playlet === null || Array.isArray(playlet)) {
    throw new Error("Claim task response data.payloadJson must be a JSON object.");
  }

  const task: ClaimedAccountTask = {
    accountTaskId: payload.data.accountTaskId,
    originalTitle: payload.data.originalTitle,
    dramaId: payload.data.dramaId,
    videoAccountId: videoAccount.id,
    videoAccountName: videoAccount.name,
    playlet: playlet as Record<string, unknown>,
  };
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
  const url = "/dramaAiRpa/rpa/successCallback";
  const requestPayload = {
    accountTaskId: successReport.accountTaskId,
  };
  logger.info("success callback request", {
    url,
    accountTaskId: successReport.accountTaskId,
  });
  const payload = await httpClient.post<TaskCallbackResponse>(url, requestPayload);
  logger.info("success callback response", {
    accountTaskId: successReport.accountTaskId,
    code: payload.code,
    responseMessage: payload.msg,
  });
  assertTaskApiResponseOk(payload, "Task success callback");
  logger.info("success callback completed", {
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
  const url = "/dramaAiRpa/rpa/failCallback";
  const requestPayload = {
    accountTaskId: errorReport.accountTaskId,
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
  const payload = await httpClient.post<TaskCallbackResponse>(url, requestPayload);
  logger.info("fail callback response", {
    accountTaskId: errorReport.accountTaskId,
    code: payload.code,
    responseMessage: payload.msg,
  });
  assertTaskApiResponseOk(payload, "Task fail callback");
  logger.info("fail callback completed", {
    accountTaskId: errorReport.accountTaskId,
    failStage: errorReport.failStage,
  });
}
