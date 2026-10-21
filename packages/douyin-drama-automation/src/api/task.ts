import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import { z } from "zod";
import {
  DOUYIN_DRAMA_AIGC_TOOL,
  DOUYIN_DRAMA_CREATOR_NAME,
  DOUYIN_DRAMA_PRODUCTION_COST_RANGE,
  DOUYIN_DRAMA_PRODUCTION_TEAM,
  DOUYIN_DRAMA_UPDATE_STATUS,
} from "../shared/constants.js";
import {
  claimedDouyinDramaTaskSchema,
  type ClaimedDouyinDramaTask,
  type DouyinDramaApiConfig,
  type DouyinDramaRuntimeOptions,
  type DouyinDramaTaskFailStage,
} from "../shared/types.js";
import { log, warn } from "../shared/logger.js";
import { createDouyinDramaHttpClient, type DouyinDramaHttpClient } from "./http-client.js";

export type DouyinDramaTaskApiEndpoints = {
  accountTaskPage: string;
  claimTask: string;
  reportTask: string;
};

export type DouyinDramaTaskApiOptions = {
  apiConfig?: DouyinDramaApiConfig;
  client?: DouyinDramaHttpClient;
  endpoints?: Partial<DouyinDramaTaskApiEndpoints>;
  runtimeOptions?: DouyinDramaRuntimeOptions;
};

const defaultEndpoints: DouyinDramaTaskApiEndpoints = {
  accountTaskPage: "/dramaAiRpa/douyin/accountTask/page",
  claimTask: "/dramaAiRpa/douyin/rpa/claim",
  reportTask: "/dramaAiRpa/douyin/rpa/report",
};
const requiredText = z.string().trim().min(1);
const nullableText = z.string().nullish();
const jsonRecordSchema = z.record(z.string(), z.unknown());
const apiResponseBaseSchema = z.object({ code: z.number(), msg: nullableText });
const readyTaskSchema = z.object({
  id: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  accountId: requiredText,
  accountName: nullableText,
  status: nullableText,
  originalTitle: nullableText,
}).passthrough();
const accountTaskPageResponseSchema = apiResponseBaseSchema.extend({
  data: z.object({
    total: z.coerce.number().int().nonnegative().optional(),
    data: z.array(readyTaskSchema),
  }).nullish(),
});
const douyinContractFileSchema = z.object({
  fileType: z.enum(["CONTRACT", "AUTHORIZATION", "COST_REPORT", "COMMITMENT"]),
  fileUrl: z.string().trim().url(),
  tosKey: z.string().trim().nullish(),
});
const douyinDramaClaimDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: nullableText,
  accountId: nullableText,
  accountName: nullableText,
  rpaProfileKey: nullableText,
  accountConfigJson: jsonRecordSchema.nullish(),
  payloadJson: z.unknown(),
});

export const douyinDramaClaimResponseSchema = apiResponseBaseSchema.extend({
  data: douyinDramaClaimDataSchema.nullish(),
});
export const douyinDramaReportResponseSchema = apiResponseBaseSchema.extend({
  data: z.boolean().nullish(),
});

type ReadyTask = z.infer<typeof readyTaskSchema>;

function taskClient(options: DouyinDramaTaskApiOptions) {
  if (options.client) return options.client;
  if (!options.apiConfig?.baseUrl.trim()) throw new Error("DOUYIN_DRAMA_API_BASE_URL_REQUIRED");
  return createDouyinDramaHttpClient(options.apiConfig);
}

function taskEndpoints(options: DouyinDramaTaskApiOptions) {
  return { ...defaultEndpoints, ...options.endpoints };
}

function assertApiSuccess(payload: z.infer<typeof apiResponseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

function recordValue(value: unknown) {
  const result = jsonRecordSchema.safeParse(value);
  return result.success ? result.data : {};
}

function parsePayloadJson(value: unknown) {
  if (typeof value === "string") return jsonRecordSchema.parse(JSON.parse(value));
  return jsonRecordSchema.parse(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringArray(value: unknown) {
  const result = z.array(z.string().trim().min(1)).safeParse(value);
  return result.success ? result.data : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function contractFileUrls(payload: Record<string, unknown>, fileType: string) {
  const result = z.array(douyinContractFileSchema).safeParse(payload.douyinContractFiles);
  if (!result.success) return [];
  return result.data.filter((file) => file.fileType === fileType).map((file) => file.fileUrl);
}

export function normalizeClaimedDouyinDramaTask(
  input: z.input<typeof douyinDramaClaimDataSchema>,
  listedTask?: ReadyTask,
  runtimeOptions?: DouyinDramaRuntimeOptions,
): ClaimedDouyinDramaTask {
  const claimed = douyinDramaClaimDataSchema.parse(input);
  const expectedAccountId = runtimeOptions?.douyinAccountId?.trim();
  const claimedAccountId = claimed.accountId?.trim();
  if (expectedAccountId && claimedAccountId && expectedAccountId !== claimedAccountId) {
    throw new Error(
      `DOUYIN_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${expectedAccountId} ` +
        `actual=${claimedAccountId}`,
    );
  }

  const payload = parsePayloadJson(claimed.payloadJson);
  const accountConfig = recordValue(claimed.accountConfigJson);
  const accountPlaylet = recordValue(accountConfig.douyinPlaylet);
  const platformPayload = recordValue(payload.douyinPlaylet);
  const playlet = {
    ...accountConfig,
    ...accountPlaylet,
    ...payload,
    ...platformPayload,
  };
  const copyright = {
    ...recordValue(playlet.copyright),
    ...recordValue(payload.copyright),
  };
  const productionCost = {
    ...recordValue(playlet.productionCost),
    ...recordValue(payload.productionCost),
  };
  const result = claimedDouyinDramaTaskSchema.safeParse({
    accountTaskId: claimed.accountTaskId,
    dramaId: listedTask?.dramaId,
    originalTitle:
      claimed.originalTitle?.trim()
      || listedTask?.originalTitle?.trim()
      || stringValue(payload.name)
      || stringValue(playlet.title),
    douyinAccountId: claimedAccountId ?? listedTask?.accountId ?? expectedAccountId,
    douyinAccountName:
      claimed.accountName?.trim()
      || listedTask?.accountName?.trim()
      || runtimeOptions?.douyinAccountName,
    playlet: {
      ...playlet,
      title: stringValue(playlet.title) ?? stringValue(payload.name),
      summary: stringValue(playlet.summary) ?? stringValue(payload.summary),
      episodeCount: numberValue(playlet.episodeCount) ?? numberValue(payload.episodeCount),
      baiduPanResourceLink:
        stringValue(playlet.baiduPanResourceLink) ?? stringValue(payload.baiduPanResourceLink),
      updateStatus: DOUYIN_DRAMA_UPDATE_STATUS,
      aigcTools: playlet.isAi === false ? [] : [DOUYIN_DRAMA_AIGC_TOOL],
      productionOrganization: DOUYIN_DRAMA_PRODUCTION_TEAM,
      producers: [DOUYIN_DRAMA_CREATOR_NAME],
      directors: [DOUYIN_DRAMA_CREATOR_NAME],
      screenwriters: [],
      productionCostRange: DOUYIN_DRAMA_PRODUCTION_COST_RANGE,
      productionCostWan: 1,
      contractName: stringValue(playlet.contractName),
      costConfigurationFiles: uniqueStrings([
        ...stringArray(playlet.costConfigurationFiles),
        ...stringArray(productionCost.proofFiles),
        ...contractFileUrls(payload, "COST_REPORT"),
      ]),
      ownershipProofFiles: uniqueStrings([
        ...stringArray(playlet.ownershipProofFiles),
        ...stringArray(copyright.productionProofFiles),
        ...stringArray(copyright.licenseProofFiles),
        ...contractFileUrls(payload, "CONTRACT"),
        ...contractFileUrls(payload, "AUTHORIZATION"),
      ]),
      nonInfringementCommitmentFiles: uniqueStrings([
        ...stringArray(playlet.nonInfringementCommitmentFiles),
        ...stringArray(payload.commitmentFiles),
        ...contractFileUrls(payload, "COMMITMENT"),
      ]),
      submit: true,
    },
  });
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  throw new Error(`DOUYIN_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

async function report(
  options: DouyinDramaTaskApiOptions & {
    taskId: number;
    success: boolean;
    failStage?: DouyinDramaTaskFailStage;
    errorMessage?: string;
    resultJson?: Record<string, unknown>;
  },
) {
  const payload = douyinDramaReportResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).reportTask, {
      taskId: options.taskId,
      success: options.success,
      failStage: options.failStage,
      errorMessage: options.errorMessage,
      resultJson: options.resultJson,
    }),
  );
  assertApiSuccess(payload, "DOUYIN_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) throw new Error("DOUYIN_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
}

async function claimById(
  options: DouyinDramaTaskApiOptions,
  accountTaskId: number,
  listedTask: ReadyTask,
) {
  const payload = douyinDramaClaimResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).claimTask, { accountTaskId }),
  );
  assertApiSuccess(payload, "DOUYIN_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  if (!payload.data) return null;
  if (payload.data.accountTaskId !== accountTaskId) {
    throw new Error(
      `DOUYIN_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${accountTaskId} ` +
        `actual=${payload.data.accountTaskId}`,
    );
  }
  try {
    return normalizeClaimedDouyinDramaTask(payload.data, listedTask, options.runtimeOptions);
  } catch (error) {
    await report({
      ...options,
      taskId: payload.data.accountTaskId,
      success: false,
      failStage: "OTHER",
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

export async function claimNextDouyinDramaTaskApi(
  options: DouyinDramaTaskApiOptions,
): Promise<ClaimedDouyinDramaTask | null> {
  const accountId = options.runtimeOptions?.douyinAccountId?.trim();
  if (!accountId) throw new Error("DOUYIN_DRAMA_ACCOUNT_ID_REQUIRED");
  const pagePayload = accountTaskPageResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).accountTaskPage, {
      page: 1,
      pageSize: 100,
      dramaId: null,
      originalTitle: null,
      accountId,
      accountName: null,
      status: "READY",
      auditStatus: null,
    }),
  );
  assertApiSuccess(pagePayload, "DOUYIN_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  const readyTasks = (pagePayload.data?.data ?? []).filter(
    (task) => task.accountId === accountId && task.status === "READY",
  );
  log(
    options.runtimeOptions ?? {},
    `[douyin-drama] 获取到 ${readyTasks.length} 条 READY 任务。`,
    { accountId, readyTaskCount: readyTasks.length },
    "polling",
  );
  for (const listedTask of readyTasks) {
    try {
      const claimed = await claimById(options, listedTask.id, listedTask);
      if (claimed) return claimed;
    } catch (error) {
      warn(
        options.runtimeOptions ?? {},
        `[douyin-drama] 领取任务失败，继续尝试下一条：taskId=${listedTask.id}`,
        { accountId, accountTaskId: listedTask.id, error },
        "polling",
      );
    }
  }
  return null;
}

export async function reportDouyinDramaTaskSuccessApi(
  options: DouyinDramaTaskApiOptions & {
    accountTaskId: number;
    resultJson?: Record<string, unknown>;
  },
): Promise<void> {
  await report({
    ...options,
    taskId: options.accountTaskId,
    success: true,
    resultJson: options.resultJson,
  });
}

export async function reportDouyinDramaTaskErrorApi(
  options: DouyinDramaTaskApiOptions & {
    accountTaskId: number;
    failStage: DouyinDramaTaskFailStage;
    errorMessage: string;
  },
): Promise<void> {
  if (isBrowserClosedError(options.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(options.errorMessage, {
    fallbackMessage: "抖音任务提交失败，未获取到具体错误原因",
  });
  await report({
    ...options,
    taskId: options.accountTaskId,
    success: false,
    failStage: options.failStage,
    errorMessage,
  });
}
