import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import { log } from "../shared/logger.js";
import {
  claimedBaiduDramaTaskSchema,
  type BaiduDramaApiConfig,
  type BaiduDramaRuntimeOptions,
  type BaiduDramaTaskFailStage,
  type ClaimedBaiduDramaTask,
} from "../shared/types.js";
import { createBaiduDramaHttpClient, type BaiduDramaHttpClient } from "./http-client.js";

export type BaiduDramaTaskApiEndpoints = {
  accountTaskPage: string;
  claimTask: string;
  reportTask: string;
};

export type BaiduDramaTaskApiOptions = {
  apiConfig?: BaiduDramaApiConfig;
  client?: BaiduDramaHttpClient;
  endpoints?: Partial<BaiduDramaTaskApiEndpoints>;
};

export type ClaimNextBaiduDramaTaskOptions = BaiduDramaTaskApiOptions & {
  runtimeOptions?: BaiduDramaRuntimeOptions;
};

export type BaiduDramaTaskSuccessReport = BaiduDramaTaskApiOptions & {
  runtimeOptions?: BaiduDramaRuntimeOptions;
  accountTaskId: number;
  externalId?: string;
  platformDramaId?: string;
  resultJson?: Record<string, unknown>;
};

export type BaiduDramaTaskErrorReport = BaiduDramaTaskApiOptions & {
  runtimeOptions?: BaiduDramaRuntimeOptions;
  accountTaskId: number;
  failStage: BaiduDramaTaskFailStage;
  errorMessage: string;
  resultJson?: Record<string, unknown>;
};

const defaultEndpoints: BaiduDramaTaskApiEndpoints = {
  accountTaskPage: "/dramaAiRpa/baidu/accountTask/page",
  claimTask: "/dramaAiRpa/baidu/rpa/claim",
  reportTask: "/dramaAiRpa/baidu/rpa/report",
};
const readyTaskPageSize = 100;
const requiredText = z.string().trim().min(1);
const nullableText = z.string().trim().nullish();
const jsonRecordSchema = z.record(z.string(), z.unknown());

const apiResponseBaseSchema = z.object({
  code: z.number(),
  msg: z.string().nullish(),
});

const readyAccountTaskSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    dramaId: z.coerce.number().int().positive().optional(),
    accountId: requiredText,
    accountName: nullableText,
    status: nullableText,
    originalTitle: nullableText,
  })
  .passthrough();

const accountTaskPageResponseSchema = apiResponseBaseSchema.extend({
  data: z
    .object({
      total: z.coerce.number().int().nonnegative().optional(),
      data: z.array(readyAccountTaskSchema),
    })
    .nullish(),
});

const baiduContractFileSchema = z.object({
  fileType: z.enum(["CONTRACT", "AUTHORIZATION", "COST_REPORT", "COMMITMENT"]),
  fileUrl: z.string().trim().url(),
  tosKey: z.string().trim().nullish(),
});

const baiduDramaClaimDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: requiredText,
  accountId: nullableText,
  accountName: nullableText,
  rpaProfileKey: nullableText,
  accountConfigJson: z.unknown().nullish(),
  payloadJson: z.unknown(),
});

export const baiduDramaClaimResponseSchema = apiResponseBaseSchema.extend({
  data: baiduDramaClaimDataSchema.nullish(),
});

export const baiduDramaReportResponseSchema = apiResponseBaseSchema.extend({
  data: z.boolean().nullish(),
});

type ReadyAccountTask = z.infer<typeof readyAccountTaskSchema>;

function taskClient(options: BaiduDramaTaskApiOptions) {
  if (options.client) return options.client;
  if (!options.apiConfig?.baseUrl.trim()) {
    throw new Error("BAIDU_DRAMA_API_BASE_URL_REQUIRED");
  }
  return createBaiduDramaHttpClient(options.apiConfig);
}

function taskEndpoints(options: BaiduDramaTaskApiOptions) {
  return { ...defaultEndpoints, ...options.endpoints };
}

function assertApiSuccess(payload: z.infer<typeof apiResponseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  const result = jsonRecordSchema.safeParse(value);
  return result.success ? result.data : {};
}

function parsePayloadJson(value: unknown) {
  if (typeof value === "string") {
    return jsonRecordSchema.parse(JSON.parse(value));
  }
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

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function contractFileUrls(payload: Record<string, unknown>, fileType: string) {
  const result = z.array(baiduContractFileSchema).safeParse(payload.baiduContractFiles);
  if (!result.success) return [];
  return result.data.filter((file) => file.fileType === fileType).map((file) => file.fileUrl);
}

function classifyClaimedTaskFailStage(error: unknown): BaiduDramaTaskFailStage {
  const message = error instanceof Error ? error.message : String(error);
  return /contract|authorization|cost|commitment|copyright|qualification|file|合同|授权|成本|承诺|文件/i.test(
    message,
  )
    ? "UPLOAD_FILE"
    : "OTHER";
}

export function normalizeClaimedBaiduDramaTask(
  input: z.input<typeof baiduDramaClaimDataSchema>,
  options: {
    listedTask?: ReadyAccountTask;
    runtimeOptions?: BaiduDramaRuntimeOptions;
  } = {},
): ClaimedBaiduDramaTask {
  const claimed = baiduDramaClaimDataSchema.parse(input);
  const expectedAccountId = options.runtimeOptions?.baiduAccountId?.trim();
  const claimedAccountId = claimed.accountId?.trim();
  if (expectedAccountId && claimedAccountId && expectedAccountId !== claimedAccountId) {
    throw new Error(
      `BAIDU_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${expectedAccountId} ` +
        `actual=${claimedAccountId}`,
    );
  }

  const payload = parsePayloadJson(claimed.payloadJson);
  const accountConfig = recordValue(claimed.accountConfigJson);
  const accountPlaylet = recordValue(accountConfig.baiduPlaylet);
  const payloadPlaylet = recordValue(payload.baiduPlaylet);
  const baiduPlaylet = {
    ...accountConfig,
    ...accountPlaylet,
    ...payload,
    ...payloadPlaylet,
  };
  const copyright = {
    ...recordValue(baiduPlaylet.copyright),
    ...recordValue(payload.copyright),
  };
  const qualification = {
    ...recordValue(baiduPlaylet.qualification),
    ...recordValue(payload.qualification),
  };
  const productionCost = {
    ...recordValue(baiduPlaylet.productionCost),
    ...recordValue(payload.productionCost),
  };
  const productionOrganization =
    stringValue(baiduPlaylet.productionOrganization) ?? stringValue(payload.producerName);

  const result = claimedBaiduDramaTaskSchema.safeParse({
    accountTaskId: claimed.accountTaskId,
    dramaId: options.listedTask?.dramaId,
    originalTitle: claimed.originalTitle ?? options.listedTask?.originalTitle,
    baiduAccountId: claimedAccountId ?? options.listedTask?.accountId ?? expectedAccountId,
    baiduAccountName:
      claimed.accountName ??
      options.listedTask?.accountName ??
      options.runtimeOptions?.baiduAccountName,
    playlet: {
      ...baiduPlaylet,
      title: stringValue(baiduPlaylet.title) ?? stringValue(payload.name) ?? claimed.originalTitle,
      summary: stringValue(baiduPlaylet.summary) ?? stringValue(payload.summary),
      episodeCount: numberValue(baiduPlaylet.episodeCount) ?? numberValue(payload.episodeCount),
      baiduPanResourceLink:
        stringValue(baiduPlaylet.baiduPanResourceLink) ?? stringValue(payload.baiduPanResourceLink),
      productionOrganization,
      isMatched: false,
      matchedIp: undefined,
      director: {
        name: productionOrganization,
        gender: "男",
      },
      producers: productionOrganization ? [productionOrganization] : [],
      screenwriters: productionOrganization ? [productionOrganization] : [],
      actors: productionOrganization
        ? [
            { name: productionOrganization, roleName: productionOrganization },
            { name: productionOrganization, roleName: productionOrganization },
          ]
        : [],
      copyright: {
        ...copyright,
        productionProofFiles: uniqueStrings(contractFileUrls(payload, "CONTRACT")),
        licenseProofFiles: uniqueStrings(contractFileUrls(payload, "AUTHORIZATION")),
      },
      qualification,
      productionCost: {
        ...productionCost,
        amountWan:
          numberValue(productionCost.amountWan) ?? numberValue(baiduPlaylet.productionCostWan),
        proofFiles: uniqueStrings(contractFileUrls(payload, "COST_REPORT")),
      },
      commitmentFiles: uniqueStrings(contractFileUrls(payload, "COMMITMENT")),
      submit: true,
    },
  });
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  throw new Error(`BAIDU_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

async function fetchReadyTasks(options: ClaimNextBaiduDramaTaskOptions) {
  const accountId = options.runtimeOptions?.baiduAccountId?.trim();
  if (!accountId) throw new Error("BAIDU_DRAMA_ACCOUNT_ID_REQUIRED");

  const payload = accountTaskPageResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).accountTaskPage, {
      page: 1,
      pageSize: readyTaskPageSize,
      dramaId: null,
      originalTitle: null,
      accountId,
      accountName: null,
      status: "READY",
      auditStatus: null,
    }),
  );
  assertApiSuccess(payload, "BAIDU_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  return (payload.data?.data ?? []).filter(
    (task) => task.accountId === accountId && task.status === "READY",
  );
}

async function reportBaiduDramaTask(
  report: BaiduDramaTaskApiOptions & {
    taskId: number;
    success: boolean;
    externalId?: string;
    platformDramaId?: string;
    failStage?: BaiduDramaTaskFailStage;
    errorMessage?: string;
    resultJson?: Record<string, unknown>;
  },
) {
  const payload = baiduDramaReportResponseSchema.parse(
    await taskClient(report).post(taskEndpoints(report).reportTask, {
      taskId: report.taskId,
      success: report.success,
      externalId: report.externalId,
      platformDramaId: report.platformDramaId,
      failStage: report.failStage,
      errorMessage: report.errorMessage,
      resultJson: report.resultJson ?? {},
    }),
  );
  assertApiSuccess(payload, "BAIDU_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) {
    throw new Error("BAIDU_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
  }
}

async function claimTask(
  options: ClaimNextBaiduDramaTaskOptions,
  accountTaskId: number,
  listedTask?: ReadyAccountTask,
) {
  const payload = baiduDramaClaimResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).claimTask, {
      accountTaskId,
    }),
  );
  assertApiSuccess(payload, "BAIDU_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  if (!payload.data) return null;
  if (payload.data.accountTaskId !== accountTaskId) {
    throw new Error(
      `BAIDU_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${accountTaskId} ` +
        `actual=${payload.data.accountTaskId}`,
    );
  }

  try {
    return normalizeClaimedBaiduDramaTask(payload.data, {
      listedTask,
      runtimeOptions: options.runtimeOptions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportBaiduDramaTask({
      ...options,
      taskId: payload.data.accountTaskId,
      success: false,
      failStage: classifyClaimedTaskFailStage(error),
      errorMessage: message,
      resultJson: {
        accountId: options.runtimeOptions?.baiduAccountId,
        accountName: options.runtimeOptions?.baiduAccountName,
      },
    }).catch((reportError) => {
      log(
        options.runtimeOptions ?? {},
        `[baidu-drama] invalid claimed task report failed: ` +
          `accountTaskId=${payload.data?.accountTaskId} ` +
          `error=${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    });
    throw error;
  }
}

export async function claimBaiduDramaTaskByIdApi(
  options: ClaimNextBaiduDramaTaskOptions & { accountTaskId: number },
): Promise<ClaimedBaiduDramaTask | null> {
  return claimTask(options, options.accountTaskId);
}

export async function claimNextBaiduDramaTaskApi(
  options: ClaimNextBaiduDramaTaskOptions,
): Promise<ClaimedBaiduDramaTask | null> {
  const readyTasks = await fetchReadyTasks(options);
  if (readyTasks.length === 0) return null;

  log(options.runtimeOptions ?? {}, `[baidu-drama] fetched ${readyTasks.length} READY task(s)`);
  for (const listedTask of readyTasks) {
    try {
      const claimed = await claimTask(options, listedTask.id, listedTask);
      if (claimed) return claimed;
    } catch (error) {
      log(
        options.runtimeOptions ?? {},
        `[baidu-drama] task claim failed: accountTaskId=${listedTask.id} ` +
          `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

export async function reportBaiduDramaTaskSuccessApi(
  report: BaiduDramaTaskSuccessReport,
): Promise<void> {
  await reportBaiduDramaTask({
    ...report,
    taskId: report.accountTaskId,
    success: true,
    resultJson: report.resultJson ?? { message: "提交成功" },
  });
}

export async function reportBaiduDramaTaskErrorApi(
  report: BaiduDramaTaskErrorReport,
): Promise<void> {
  if (isBrowserClosedError(report.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(report.errorMessage, {
    fallbackMessage: "百度任务提交失败，未获取到具体错误原因",
  });
  await reportBaiduDramaTask({
    ...report,
    taskId: report.accountTaskId,
    success: false,
    failStage: report.failStage,
    errorMessage,
    resultJson: report.resultJson ?? {},
  });
}
