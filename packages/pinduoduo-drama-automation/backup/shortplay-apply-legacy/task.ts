import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import { createLogger } from "../shared/logger.js";
import { PINDUODUO_DEFAULT_COPYRIGHT_EXPIRE_TIME } from "../shared/constants.js";
import {
  pinduoduoDramaClaimedTaskSchema,
  pinduoduoDramaTaskFailStageValues,
  pinduoduoDramaTaskPayloadSchema,
  type ClaimedPinduoduoDramaTask,
  type PinduoduoDramaApiConfig,
  type PinduoduoDramaTaskFailStage,
  type PinduoduoDramaTaskStatus,
} from "../shared/types.js";
import { createPinduoduoDramaHttpClient, type PinduoduoDramaHttpClient } from "./http-client.js";

export interface PinduoduoDramaTaskApiEndpoints {
  accountTaskPage: string;
  claimTask: string;
  successCallback: string;
  failCallback: string;
}

export interface PinduoduoDramaTaskApiOptions {
  apiConfig?: PinduoduoDramaApiConfig;
  client?: PinduoduoDramaHttpClient;
  endpoints?: Partial<PinduoduoDramaTaskApiEndpoints>;
}

export interface ClaimNextPinduoduoDramaTaskOptions extends PinduoduoDramaTaskApiOptions {
  excludedAccountTaskIds?: ReadonlySet<number>;
  pinduoduoAccountId?: string;
  pinduoduoAccountName?: string;
  rpaStatus?: PinduoduoDramaTaskStatus;
}

export interface ClaimPinduoduoDramaTaskByIdOptions extends PinduoduoDramaTaskApiOptions {
  accountTaskId: number;
  pinduoduoAccountId?: string;
  pinduoduoAccountName?: string;
}

export interface PinduoduoDramaTaskSuccessReport extends PinduoduoDramaTaskApiOptions {
  accountTaskId: number;
  resultJson?: Record<string, unknown>;
  rpaStatus?: PinduoduoDramaTaskStatus;
}

export interface PinduoduoDramaTaskErrorReport extends PinduoduoDramaTaskApiOptions {
  accountTaskId: number;
  dramaId?: number;
  failStage: PinduoduoDramaTaskFailStage;
  errorMessage: string;
  resultJson?: Record<string, unknown>;
}

const defaultEndpoints: PinduoduoDramaTaskApiEndpoints = {
  accountTaskPage: "/pinduoduoDramaRpa/accountTask/page",
  claimTask: "/pinduoduoDramaRpa/rpa/claim",
  successCallback: "/pinduoduoDramaRpa/rpa/successCallback",
  failCallback: "/pinduoduoDramaRpa/rpa/failCallback",
};

const accountTaskPageItemSchema = z.object({
  id: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: z.string().trim().optional(),
  pinduoduoAccountId: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => (value === undefined ? undefined : String(value))),
  pinduoduoAccountName: z.string().trim().optional(),
  rpaStatus: z.string().trim().optional(),
});

const accountTaskPageResponseSchema = z.object({
  code: z.coerce.number(),
  msg: z.string().optional(),
  data: z
    .object({
      total: z.coerce.number().int().nonnegative().default(0),
      data: z.array(accountTaskPageItemSchema).default([]),
    })
    .nullable()
    .optional(),
});

const claimTaskResponseSchema = z.object({
  code: z.coerce.number(),
  msg: z.string().optional(),
  data: z
    .object({
      accountTaskId: z.coerce.number().int().positive(),
      dramaId: z.coerce.number().int().positive().optional(),
      originalTitle: z.string().trim().optional(),
      pinduoduoAccountId: z
        .union([z.string(), z.number()])
        .optional()
        .transform((value) => (value === undefined ? undefined : String(value))),
      pinduoduoAccountName: z.string().trim().optional(),
      payloadJson: z.unknown().optional(),
      playlet: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});

const callbackResponseSchema = z.object({
  code: z.coerce.number().optional(),
  msg: z.string().optional(),
});

const logger = createLogger("task-api");

const mockClaimedTask = pinduoduoDramaClaimedTaskSchema.parse({
  accountTaskId: 2026071101,
  dramaId: 880001,
  originalTitle: "归来后我成了全城首富",
  pinduoduoAccountId: "1053168546",
  pinduoduoAccountName: "草莓漫剧",
  playlet: {
    contentType: 1,
    subContentType: 2,
    isSeriesPlay: false,
    copyright: 2,
    copyrightExpireTime: PINDUODUO_DEFAULT_COPYRIGHT_EXPIRE_TIME,
    title: "归来后我成了全城首富",
    director: "明星说",
    producer: "明星说",
    scriptWriter: "明星说",
    role: "顾星澜",
    episodeCount: 55,
    durationMinutes: 1,
    durationSeconds: 12,
    cate: 1,
    labelIds: [4441, 4468],
    copyrightAgency: "明星说（北京）科技有限公司",
    cost: "1",
    salaryPercent: "10",
    majorSalaryPercent: "10",
    demoUrl: "https://pan.baidu.com/s/1mockPinduoduoShortplayDemo?pwd=9x8k",
    summary:
      "顾星澜曾是顾家最不起眼的养女，被未婚夫和继妹联手陷害后远走海外。五年后，她带着自主创立的商业集团回到江城，以投资人的身份重新出现在众人面前。面对昔日亲人的轻视、商业对手的围堵和旧爱迟来的悔悟，顾星澜一步步揭开当年的真相，也在复仇与守护之间重新找回自己的家人和爱情。全剧以都市逆袭和情感成长为主线，节奏紧凑，冲突集中。前半段通过家族误会、商业谈判和身份反转制造强钩子，中段围绕集团危机、亲情修复和旧案证据推进人物关系，后半段集中展现女主反击幕后黑手、夺回尊严并完成事业布局的过程。剧情兼具爽感、悬念和情感落点，每集都有明确冲突和推进，适合短剧平台分集观看，也便于通过标题、封面和切片突出女主成长与复仇逆袭看点。",
    shortplayId: "mock-shortplay-id",
    shortplayName: "归来后我成了全城首富",
    coverImageUrl: "https://example.com/mock-cover.jpg",
    episodeVideoUrls: [],
    authorName: "许知夏",
    productionProofFileUrl:
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    licenseProofFileUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  },
});

function shouldUseMockTaskApi(options: PinduoduoDramaTaskApiOptions): boolean {
  return !options.client && !options.apiConfig;
}

function endpointsOf(options: PinduoduoDramaTaskApiOptions): PinduoduoDramaTaskApiEndpoints {
  return {
    ...defaultEndpoints,
    ...options.endpoints,
  };
}

function clientOf(options: PinduoduoDramaTaskApiOptions): PinduoduoDramaHttpClient {
  if (options.client) {
    return options.client;
  }
  if (!options.apiConfig) {
    throw new Error("Pinduoduo drama apiConfig or client is required.");
  }
  return createPinduoduoDramaHttpClient(options.apiConfig);
}

function assertApiResponseOk(payload: { code?: number; msg?: string }, action: string): void {
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(`${action} failed: ${payload.msg || `code=${payload.code}`}`);
  }
}

function parsePayloadJson(value: unknown, accountTaskId: number) {
  const parsedValue = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const result = pinduoduoDramaTaskPayloadSchema.safeParse(parsedValue);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "payloadJson"}: ${issue.message}`)
    .join("; ");
  throw new Error(
    `PINDUODUO_DRAMA_TASK_PAYLOAD_INVALID accountTaskId=${accountTaskId}: ${details}`,
  );
}

async function findNextUnclaimedAccountTaskId(
  options: ClaimNextPinduoduoDramaTaskOptions,
): Promise<number | null> {
  if (shouldUseMockTaskApi(options)) {
    const accountTaskId = mockClaimedTask.accountTaskId;
    const skipped = options.excludedAccountTaskIds?.has(accountTaskId) ?? false;
    logger.info("mock account task page response", {
      selectedAccountTaskId: skipped ? undefined : accountTaskId,
      skippedAccountTaskIds: skipped ? [accountTaskId] : [],
    });
    return skipped ? null : accountTaskId;
  }

  const endpoints = endpointsOf(options);
  const client = clientOf(options);
  const requestPayload = {
    page: 1,
    pageSize: 100,
    pinduoduoAccountId: options.pinduoduoAccountId,
    rpaStatus: options.rpaStatus ?? "READY",
  };

  logger.info("account task page request", {
    url: endpoints.accountTaskPage,
    pinduoduoAccountId: options.pinduoduoAccountId,
    pinduoduoAccountName: options.pinduoduoAccountName,
    page: requestPayload.page,
    pageSize: requestPayload.pageSize,
    rpaStatus: requestPayload.rpaStatus,
  });

  const rawPayload = await client.post<unknown>(endpoints.accountTaskPage, requestPayload);
  const payload = accountTaskPageResponseSchema.parse(rawPayload);
  if (payload.code !== 0) {
    throw new Error(
      `Failed to query Pinduoduo account task page: ${payload.msg || `code=${payload.code}`}`,
    );
  }

  const items = payload.data?.data ?? [];
  const excludedAccountTaskIds = options.excludedAccountTaskIds;
  const accountTask = items.find((item) => !excludedAccountTaskIds?.has(item.id)) ?? null;
  logger.info("account task page response", {
    total: payload.data?.total ?? 0,
    rows: items.length,
    selectedAccountTaskId: accountTask?.id,
    skippedAccountTaskIds: excludedAccountTaskIds
      ? items.filter((item) => excludedAccountTaskIds.has(item.id)).map((item) => item.id)
      : [],
  });

  return accountTask?.id ?? null;
}

export async function claimPinduoduoDramaTaskByIdApi(
  options: ClaimPinduoduoDramaTaskByIdOptions,
): Promise<ClaimedPinduoduoDramaTask | null> {
  if (shouldUseMockTaskApi(options)) {
    const task = pinduoduoDramaClaimedTaskSchema.parse({
      ...mockClaimedTask,
      accountTaskId: options.accountTaskId,
      pinduoduoAccountId: options.pinduoduoAccountId ?? mockClaimedTask.pinduoduoAccountId,
      pinduoduoAccountName: options.pinduoduoAccountName ?? mockClaimedTask.pinduoduoAccountName,
    });
    logger.info("mock claimed account task", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      originalTitle: task.originalTitle,
      pinduoduoAccountId: task.pinduoduoAccountId,
      pinduoduoAccountName: task.pinduoduoAccountName,
    });
    return task;
  }

  const endpoints = endpointsOf(options);
  const client = clientOf(options);
  const requestPayload = {
    accountTaskId: options.accountTaskId,
    pinduoduoAccountId: options.pinduoduoAccountId,
  };

  logger.info("claim request", {
    url: endpoints.claimTask,
    accountTaskId: options.accountTaskId,
    pinduoduoAccountId: options.pinduoduoAccountId,
    pinduoduoAccountName: options.pinduoduoAccountName,
  });

  const rawPayload = await client.post<unknown>(endpoints.claimTask, requestPayload);
  const payload = claimTaskResponseSchema.parse(rawPayload);
  logger.info("claim response", {
    accountTaskId: options.accountTaskId,
    code: payload.code,
    responseMessage: payload.msg,
  });

  if (payload.code !== 0) {
    throw new Error(`Failed to claim Pinduoduo task: ${payload.msg || `code=${payload.code}`}`);
  }
  if (!payload.data) {
    return null;
  }

  const payloadJson = payload.data.payloadJson ?? payload.data.playlet;
  if (!payloadJson) {
    throw new Error("Claim task response data.payloadJson or data.playlet is required.");
  }

  const playlet = parsePayloadJson(payloadJson, payload.data.accountTaskId);
  const task = pinduoduoDramaClaimedTaskSchema.parse({
    accountTaskId: payload.data.accountTaskId,
    dramaId: payload.data.dramaId,
    originalTitle: payload.data.originalTitle || playlet.title,
    pinduoduoAccountId: payload.data.pinduoduoAccountId ?? options.pinduoduoAccountId,
    pinduoduoAccountName: payload.data.pinduoduoAccountName ?? options.pinduoduoAccountName,
    playlet,
  });

  logger.info("claimed account task", {
    accountTaskId: task.accountTaskId,
    dramaId: task.dramaId,
    originalTitle: task.originalTitle,
    pinduoduoAccountId: task.pinduoduoAccountId,
    pinduoduoAccountName: task.pinduoduoAccountName,
  });

  return task;
}

export async function claimNextPinduoduoDramaTaskApi(
  options: ClaimNextPinduoduoDramaTaskOptions,
): Promise<ClaimedPinduoduoDramaTask | null> {
  const accountTaskId = await findNextUnclaimedAccountTaskId(options);
  if (!accountTaskId) {
    logger.info("no claimable account task", {
      pinduoduoAccountId: options.pinduoduoAccountId,
      pinduoduoAccountName: options.pinduoduoAccountName,
      rpaStatus: options.rpaStatus ?? "READY",
    });
    return null;
  }

  return claimPinduoduoDramaTaskByIdApi({
    ...options,
    accountTaskId,
  });
}

export async function reportPinduoduoDramaTaskSuccessApi(
  report: PinduoduoDramaTaskSuccessReport,
): Promise<void> {
  if (shouldUseMockTaskApi(report)) {
    logger.info("mock success callback skipped", {
      accountTaskId: report.accountTaskId,
    });
    return;
  }

  const endpoints = endpointsOf(report);
  const client = clientOf(report);
  const requestPayload = {
    accountTaskId: report.accountTaskId,
    resultJson: report.resultJson ?? {},
    rpaStatus: report.rpaStatus,
  };

  logger.info("success callback request", {
    url: endpoints.successCallback,
    accountTaskId: report.accountTaskId,
  });
  const rawPayload = await client.post<unknown>(endpoints.successCallback, requestPayload);
  const payload = callbackResponseSchema.parse(rawPayload);
  assertApiResponseOk(payload, "Pinduoduo task success callback");
}

export async function reportPinduoduoDramaTaskErrorApi(
  report: PinduoduoDramaTaskErrorReport,
): Promise<void> {
  if (isBrowserClosedError(report.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(report.errorMessage, {
    fallbackMessage: "拼多多任务提交失败，未获取到具体错误原因",
  });
  const failStage = z.enum(pinduoduoDramaTaskFailStageValues).parse(report.failStage);
  if (shouldUseMockTaskApi(report)) {
    logger.info("mock fail callback skipped", {
      accountTaskId: report.accountTaskId,
      dramaId: report.dramaId,
      failStage,
      errorMessage,
      resultJson: report.resultJson,
    });
    return;
  }

  const endpoints = endpointsOf(report);
  const client = clientOf(report);
  const requestPayload = {
    accountTaskId: report.accountTaskId,
    failStage,
    resultJson: report.resultJson ?? {},
    errorMessage,
  };

  logger.info("fail callback request", {
    url: endpoints.failCallback,
    accountTaskId: report.accountTaskId,
    dramaId: report.dramaId,
    failStage,
    errorMessage,
    resultJson: requestPayload.resultJson,
  });
  const rawPayload = await client.post<unknown>(endpoints.failCallback, requestPayload);
  const payload = callbackResponseSchema.parse(rawPayload);
  assertApiResponseOk(payload, "Pinduoduo task fail callback");
}
