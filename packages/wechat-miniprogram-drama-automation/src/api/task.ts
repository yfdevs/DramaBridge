import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import type { ClaimedAccountTask } from "../shared/types.js";
import type { RpaFailStage } from "../shared/errors.js";
import type { WechatMiniProgramAccount } from "./mini-program-accounts.js";
import { createLogger } from "../shared/logger.js";
import { httpClient } from "./http-client.js";
import { getWechatMiniProgramRuntimeSettings } from "../shared/runtime-settings.js";
import {
  ensureWechatMiniProgramMockAssets,
  wechatMiniProgramMockAssetPaths,
} from "../shared/mock-assets.js";

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

function taskApiUrl(pathname: string): string {
  const prefix = getWechatMiniProgramRuntimeSettings().taskApiPrefix.trim().replace(/\/+$/, "");
  if (!prefix) throw new Error("taskApiPrefix is required.");
  return `${prefix}/${pathname.replace(/^\/+/, "")}`;
}

interface TaskCallbackResponse {
  code?: number;
  msg?: string;
}

export interface WechatMiniProgramClaimTaskResponse {
  code: number;
  msg: string;
  data?: {
    accountTaskId: number;
    originalTitle: string;
    dramaId?: number;
    accountId: string;
    accountName: string;
    rpaProfileKey?: string | null;
    accountConfigJson?: Record<string, unknown> | null;
    payloadJson: WechatMiniProgramTaskPayload | string;
  } | null;
}

/**
 * 微信小程序任务接口 payloadJson 中与 AI 声明相关的字段。
 * aiContent 缺省为 true；仅当接口明确返回 false 时关闭声明并跳过证明上传。
 */
export interface WechatMiniProgramTaskPayload extends Record<string, unknown> {
  aiContent?: boolean;
  aiProductionProofFiles?: string[];
}

const mockClaimedAccountIds = new Set<string>();
const mockAccountTaskIds = new Set<number>();

function stableMockSequence(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 90_000;
  }
  return hash + 1;
}

export function createMockWechatMiniProgramClaimResponse(
  account: WechatMiniProgramAccount,
): WechatMiniProgramClaimTaskResponse {
  const sequence = stableMockSequence(account.id);
  const originalTitle = "赶海救下美人鱼，她让整片大海来报恩";
  const mockAssets = wechatMiniProgramMockAssetPaths();

  return {
    code: 0,
    msg: "操作成功",
    data: {
      accountTaskId: 900_000 + sequence,
      dramaId: 800_000 + sequence,
      originalTitle,
      accountId: account.id,
      accountName: account.name,
      rpaProfileKey: account.rpaProfileKey ?? null,
      accountConfigJson: null,
      payloadJson: {
        name: originalTitle,
        platform: "wechatMiniProgram",
        summary:
          "一次意外让主人公重新站在人生的岔路口。面对亲情、事业与命运的多重考验，他凭借勇气和智慧弥补遗憾，也找到了真正值得守护的人。",
        recommendation: "改写遗憾，奔赴新的人生。",
        episodeCount: 11,
        baiduPanResourceLink:
          "通过网盘分享的文件：赶海救下美人鱼，她让整片大海来报恩\n" +
          "链接: https://pan.baidu.com/s/1DqxBmsaWkLKKol5uHKxDNQ?pwd=hm6f 提取码: hm6f\n" +
          "小桃漫画新剧@柒 ",
        monetization: "IAA广告变现",
        previewEpisodeCount: 1,
        dramaType: "数字真人",
        aiContent: true,
        aiProductionProofFiles: [mockAssets.aiProductionProof],
        posters: {
          main: "",
          promotion: "",
        },
        submissionIdentity: "版权方/授权播出方",
        producerName: "星河映像（北京）文化传媒有限公司",
        copyright: {
          applyProtection: true,
          verificationMethod: "基于版权证明材料",
          productionProofFiles: [mockAssets.productionContract],
          licenseProofFiles: [mockAssets.licenseAuthorization],
        },
        qualification: {
          type: "其他微短剧",
          proofFiles: [],
        },
        productionCost: {
          amountWan: 10,
          proofFiles: [mockAssets.productionCostProof],
        },
        otherMaterials: [],
      },
    },
  };
}

function normalizeWechatMiniProgramClaimResponse(
  payload: WechatMiniProgramClaimTaskResponse,
  account: WechatMiniProgramAccount,
): ClaimedAccountTask | null {
  if (payload.code !== 0) {
    throw new Error(`微信小程序任务领取失败：${payload.msg || `code=${payload.code}`}`);
  }
  if (!payload.data) return null;
  if (!payload.data.accountTaskId || !payload.data.originalTitle || !payload.data.payloadJson) {
    throw new Error("微信小程序任务响应缺少 accountTaskId、originalTitle 或 payloadJson");
  }

  const playlet =
    typeof payload.data.payloadJson === "string"
      ? (JSON.parse(payload.data.payloadJson) as unknown)
      : payload.data.payloadJson;
  if (typeof playlet !== "object" || playlet === null || Array.isArray(playlet)) {
    throw new Error("微信小程序任务响应的 payloadJson 必须是 JSON 对象");
  }

  return {
    accountTaskId: payload.data.accountTaskId,
    dramaId: payload.data.dramaId,
    originalTitle: payload.data.originalTitle,
    videoAccountId: account.id,
    videoAccountName: account.name,
    playlet: playlet as Record<string, unknown>,
    videoAccountConfig: payload.data.accountConfigJson ?? undefined,
    accountTask: {
      mockTask: true,
      dryRun: true,
      publish: {
        submit: false,
      },
    },
  };
}

/**
 * 创建一条字段完整、但不会与正式数据冲突的微信小程序测试任务。
 * 测试素材目录应使用返回的 originalTitle 作为本地剧目目录名。
 */
export function createMockWechatMiniProgramTask(
  account: WechatMiniProgramAccount,
): ClaimedAccountTask {
  const task = normalizeWechatMiniProgramClaimResponse(
    createMockWechatMiniProgramClaimResponse(account),
    account,
  );
  if (!task) throw new Error("微信小程序模拟任务创建失败");
  return task;
}

export function resetMockWechatMiniProgramTaskApi(): void {
  mockClaimedAccountIds.clear();
  mockAccountTaskIds.clear();
}

export function resetMockWechatMiniProgramTaskApiForTesting(): void {
  resetMockWechatMiniProgramTaskApi();
}

/**
 * 微信小程序正式领取接口占位方法。
 * 正式接口可用后只需在这里发起请求并返回标准化任务。
 */
async function requestWechatMiniProgramTaskApi(
  account: WechatMiniProgramAccount,
  options: ClaimNextTaskOptions,
): Promise<WechatMiniProgramClaimTaskResponse | undefined> {
  void account;
  void options;
  return undefined;
}

function assertTaskApiResponseOk(payload: TaskCallbackResponse, action: string): void {
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(`${action} failed: ${payload.msg || `code=${payload.code}`}`);
  }
}

export async function claimNextWechatMiniProgramTaskApi(
  account: WechatMiniProgramAccount,
  options: ClaimNextTaskOptions = {},
): Promise<ClaimedAccountTask | null> {
  const apiResponse = await requestWechatMiniProgramTaskApi(account, options);
  if (apiResponse !== undefined) {
    return normalizeWechatMiniProgramClaimResponse(apiResponse, account);
  }

  if (mockClaimedAccountIds.has(account.id)) return null;

  await ensureWechatMiniProgramMockAssets();
  const mockTask = createMockWechatMiniProgramTask(account);
  if (options.excludedAccountTaskIds?.has(mockTask.accountTaskId)) return null;

  mockClaimedAccountIds.add(account.id);
  mockAccountTaskIds.add(mockTask.accountTaskId);
  logger.info("mock claimed account task", {
    accountTaskId: mockTask.accountTaskId,
    dramaId: mockTask.dramaId,
    originalTitle: mockTask.originalTitle,
    videoAccountId: mockTask.videoAccountId,
    videoAccountName: mockTask.videoAccountName,
  });
  return mockTask;
}

export async function reportClaimedTaskSuccessApi(
  successReport: ClaimedTaskSuccessReport,
): Promise<void> {
  if (mockAccountTaskIds.has(successReport.accountTaskId)) {
    logger.info("success callback completed", {
      accountTaskId: successReport.accountTaskId,
      mock: true,
    });
    return;
  }

  const url = taskApiUrl("rpa/successCallback");
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
    fallbackMessage: "微信小程序任务提交失败，未获取到具体错误原因",
  });
  if (mockAccountTaskIds.has(errorReport.accountTaskId)) {
    logger.info("fail callback completed", {
      accountTaskId: errorReport.accountTaskId,
      failStage: errorReport.failStage,
      mock: true,
    });
    return;
  }

  const url = taskApiUrl("rpa/failCallback");
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
