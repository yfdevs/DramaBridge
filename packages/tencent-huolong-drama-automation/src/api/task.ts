import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import { z } from "zod";
import { log } from "../shared/logger.js";
import {
  claimedTencentHuolongDramaTaskSchema,
  type ClaimedTencentHuolongDramaTask,
  type TencentHuolongApiConfig,
  type TencentHuolongRuntimeOptions,
  type TencentHuolongTaskFailStage,
} from "../shared/types.js";
import {
  createTencentHuolongHttpClient,
  type TencentHuolongHttpClient,
} from "./http-client.js";

export type TencentHuolongTaskApiEndpoints = {
  accountTaskPage: string;
  claimTask: string;
  reportTask: string;
};

export type TencentHuolongTaskApiOptions = {
  apiConfig?: TencentHuolongApiConfig;
  client?: TencentHuolongHttpClient;
  endpoints?: Partial<TencentHuolongTaskApiEndpoints>;
};

export type ClaimNextTencentHuolongDramaTaskOptions = TencentHuolongTaskApiOptions & {
  runtimeOptions?: TencentHuolongRuntimeOptions;
};

export type TencentHuolongTaskSuccessReport = TencentHuolongTaskApiOptions & {
  runtimeOptions?: TencentHuolongRuntimeOptions;
  accountTaskId: number;
  externalId?: string;
  platformDramaId?: string;
  resultJson?: Record<string, unknown>;
};

export type TencentHuolongTaskErrorReport = TencentHuolongTaskApiOptions & {
  runtimeOptions?: TencentHuolongRuntimeOptions;
  accountTaskId: number;
  failStage: TencentHuolongTaskFailStage;
  errorMessage: string;
  resultJson?: Record<string, unknown>;
};

const defaultEndpoints: TencentHuolongTaskApiEndpoints = {
  accountTaskPage: "/dramaAiRpa/tencent/accountTask/page",
  claimTask: "/dramaAiRpa/tencent/rpa/claim",
  reportTask: "/dramaAiRpa/tencent/rpa/report",
};
const readyTaskPageSize = 100;
const requiredText = z.string().trim().min(1);
const nullableText = z.string().nullish();
const jsonRecord = z.record(z.string(), z.unknown());

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

const claimResponseDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: nullableText,
  accountId: nullableText,
  rpaProfileKey: nullableText,
  accountConfigJson: jsonRecord.nullish(),
  payloadJson: z.unknown(),
});

const claimResponseSchema = apiResponseBaseSchema.extend({
  data: claimResponseDataSchema.nullish(),
});

const reportResponseSchema = apiResponseBaseSchema.extend({
  data: z.boolean().nullish(),
});

type ReadyAccountTask = z.infer<typeof readyAccountTaskSchema>;
type ClaimResponseData = z.infer<typeof claimResponseDataSchema>;

function taskClient(options: TencentHuolongTaskApiOptions) {
  if (options.client) return options.client;
  if (!options.apiConfig?.baseUrl.trim()) {
    throw new Error("TENCENT_HUOLONG_DRAMA_API_BASE_URL_REQUIRED");
  }
  return createTencentHuolongHttpClient(options.apiConfig);
}

function taskEndpoints(options: TencentHuolongTaskApiOptions): TencentHuolongTaskApiEndpoints {
  return { ...defaultEndpoints, ...options.endpoints };
}

function assertApiSuccess(payload: z.infer<typeof apiResponseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parsePayloadJson(value: unknown) {
  if (typeof value === "string") return jsonRecord.parse(JSON.parse(value));
  return jsonRecord.parse(value);
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
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = stringValue(item);
    return normalized ? [normalized] : [];
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function yesNoValue(value: unknown) {
  if (value === true || value === 1 || value === "1" || value === "是") return "是";
  if (value === false || value === 0 || value === "0" || value === "否") return "否";
  return undefined;
}

function classifyClaimedTaskFailStage(error: unknown): TencentHuolongTaskFailStage {
  const message = error instanceof Error ? error.message : String(error);
  return /costAnalysisFiles|copyrightProofFiles|productionProcessFiles|文件|材料|成本|版权|工程/i.test(
    message,
  )
    ? "UPLOAD_FILE"
    : "OTHER";
}

export function normalizeClaimedTencentHuolongDramaTask(options: {
  claimed: ClaimResponseData;
  listedTask?: ReadyAccountTask;
  runtimeOptions?: TencentHuolongRuntimeOptions;
}): ClaimedTencentHuolongDramaTask {
  const { claimed, listedTask, runtimeOptions } = options;
  const expectedAccountId = runtimeOptions?.accountId?.trim();
  const claimedAccountId = claimed.accountId?.trim();
  if (expectedAccountId && claimedAccountId && expectedAccountId !== claimedAccountId) {
    throw new Error(
      `TENCENT_HUOLONG_DRAMA_CLAIMED_ACCOUNT_MISMATCH: ` +
        `expected=${expectedAccountId} actual=${claimedAccountId}`,
    );
  }

  const payload = parsePayloadJson(claimed.payloadJson);
  const payloadPlaylet = recordValue(
    payload.tencentHuolongPlaylet ?? payload.huolongPlaylet ?? payload.playlet,
  );
  const accountConfig = recordValue(claimed.accountConfigJson);
  const accountPlaylet = recordValue(
    accountConfig.tencentHuolongPlaylet ?? accountConfig.huolongPlaylet,
  );
  const playlet = { ...accountPlaylet, ...payloadPlaylet };
  const copyright = recordValue(payload.copyright);
  const production = recordValue(payload.production);
  const productionCost = recordValue(payload.productionCost);

  const result = claimedTencentHuolongDramaTaskSchema.safeParse({
    accountTaskId: claimed.accountTaskId,
    dramaId: listedTask?.dramaId,
    originalTitle:
      stringValue(claimed.originalTitle) ??
      stringValue(listedTask?.originalTitle) ??
      stringValue(payload.name) ??
      stringValue(playlet.title),
    accountId: claimedAccountId ?? listedTask?.accountId ?? expectedAccountId,
    accountName: listedTask?.accountName ?? runtimeOptions?.accountName,
    playlet: {
      ...playlet,
      title: stringValue(playlet.title) ?? stringValue(payload.name),
      summary: stringValue(playlet.summary) ?? stringValue(payload.summary),
      episodeCount: numberValue(playlet.episodeCount) ?? numberValue(payload.episodeCount),
      baiduPanResourceLink:
        stringValue(playlet.baiduPanResourceLink) ?? stringValue(payload.baiduPanResourceLink),
      protagonistName:
        stringValue(playlet.protagonistName) ?? stringValue(payload.protagonistName),
      isAiRealPersonShortDrama:
        yesNoValue(playlet.isAiRealPersonShortDrama ?? payload.isAiRealPersonShortDrama) ?? "否",
      themeType:
        stringValue(playlet.themeType) ??
        stringValue(playlet.theme) ??
        stringValue(payload.themeType) ??
        stringValue(payload.theme),
      keywords: uniqueStrings(
        stringArray(
          playlet.keywords ??
          playlet.microSeriesKeywords ??
          payload.keywords ??
          payload.microSeriesKeywords,
        ),
      ),
      costAnalysisFiles: uniqueStrings(
        stringArray(
          playlet.costAnalysisFiles ?? productionCost.proofFiles ?? production.costAnalysisFiles,
        ),
      ),
      copyrightProofFiles: uniqueStrings([
        ...stringArray(
          playlet.copyrightProofFiles ?? copyright.productionProofFiles ?? copyright.proofFiles,
        ),
        ...stringArray(copyright.licenseProofFiles),
      ]),
      productionProcessFiles: uniqueStrings(
        stringArray(playlet.productionProcessFiles ?? production.processFiles),
      ),
    },
  });
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  throw new Error(`TENCENT_HUOLONG_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

async function fetchReadyTasks(options: ClaimNextTencentHuolongDramaTaskOptions) {
  const accountId = options.runtimeOptions?.accountId?.trim();
  if (!accountId) throw new Error("TENCENT_HUOLONG_DRAMA_ACCOUNT_ID_REQUIRED");

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
  assertApiSuccess(payload, "TENCENT_HUOLONG_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  return (payload.data?.data ?? []).filter(
    (task) => task.accountId === accountId && task.status === "READY",
  );
}

async function reportTencentHuolongDramaTask(options: TencentHuolongTaskApiOptions & {
  taskId: number;
  success: boolean;
  externalId?: string;
  platformDramaId?: string;
  failStage?: TencentHuolongTaskFailStage;
  errorMessage?: string;
  resultJson?: Record<string, unknown>;
}) {
  const payload = reportResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).reportTask, {
      taskId: options.taskId,
      success: options.success,
      externalId: options.externalId,
      platformDramaId: options.platformDramaId,
      failStage: options.failStage,
      resultJson: options.resultJson ?? {},
      errorMessage: options.errorMessage,
    }),
  );
  assertApiSuccess(payload, "TENCENT_HUOLONG_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) {
    throw new Error("TENCENT_HUOLONG_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
  }
}

async function claimTask(
  options: ClaimNextTencentHuolongDramaTaskOptions,
  accountTaskId: number,
  listedTask?: ReadyAccountTask,
) {
  const payload = claimResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).claimTask, { accountTaskId }),
  );
  assertApiSuccess(payload, "TENCENT_HUOLONG_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  if (!payload.data) return null;
  if (payload.data.accountTaskId !== accountTaskId) {
    throw new Error(
      `TENCENT_HUOLONG_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${accountTaskId} ` +
        `actual=${payload.data.accountTaskId}`,
    );
  }

  try {
    return normalizeClaimedTencentHuolongDramaTask({
      claimed: payload.data,
      listedTask,
      runtimeOptions: options.runtimeOptions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportTencentHuolongDramaTask({
      ...options,
      taskId: payload.data.accountTaskId,
      success: false,
      failStage: classifyClaimedTaskFailStage(error),
      errorMessage: message,
      resultJson: {
        accountId: options.runtimeOptions?.accountId,
        accountName: options.runtimeOptions?.accountName,
      },
    }).catch((reportError) => {
      log(
        options.runtimeOptions ?? {},
        `[tencent-huolong-drama] 无效领取任务回写失败：accountTaskId=${accountTaskId} ` +
          `error=${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    });
    throw error;
  }
}

export async function claimNextTencentHuolongDramaTaskApi(
  options: ClaimNextTencentHuolongDramaTaskOptions,
): Promise<ClaimedTencentHuolongDramaTask | null> {
  const readyTasks = await fetchReadyTasks(options);
  if (readyTasks.length === 0) return null;

  log(options.runtimeOptions ?? {}, `[tencent-huolong-drama] 获取到 ${readyTasks.length} 条 READY 任务`);
  for (const listedTask of readyTasks) {
    try {
      const claimed = await claimTask(options, listedTask.id, listedTask);
      if (claimed) return claimed;
    } catch (error) {
      log(
        options.runtimeOptions ?? {},
        `[tencent-huolong-drama] 领取任务失败：accountTaskId=${listedTask.id} ` +
          `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

export async function reportTencentHuolongDramaTaskSuccessApi(
  report: TencentHuolongTaskSuccessReport,
): Promise<void> {
  await reportTencentHuolongDramaTask({
    ...report,
    taskId: report.accountTaskId,
    success: true,
  });
}

export async function reportTencentHuolongDramaTaskErrorApi(
  report: TencentHuolongTaskErrorReport,
): Promise<void> {
  if (isBrowserClosedError(report.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(report.errorMessage, {
    fallbackMessage: "腾讯火龙漫剧任务提交失败，未获取到具体错误原因",
  });
  await reportTencentHuolongDramaTask({
    ...report,
    taskId: report.accountTaskId,
    success: false,
    errorMessage,
  });
}
