import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import { log } from "../shared/logger.js";
import { withWeiboProgress } from "../shared/progress.js";
import {
  claimedWeiboDramaTaskSchema,
  type ClaimedWeiboDramaTask,
  type WeiboDramaApiConfig,
  type WeiboDramaRuntimeOptions,
  type WeiboDramaTaskFailStage,
  type WeiboDramaTaskStatus,
} from "../shared/types.js";
import { createWeiboDramaHttpClient, type WeiboDramaHttpClient } from "./http-client.js";

export type WeiboDramaTaskApiEndpoints = {
  accountTaskPage: string;
  claimTask: string;
  reportTask: string;
};

export type WeiboDramaTaskApiOptions = {
  apiConfig?: WeiboDramaApiConfig;
  client?: WeiboDramaHttpClient;
  endpoints?: Partial<WeiboDramaTaskApiEndpoints>;
};

export type ClaimNextWeiboDramaTaskOptions = WeiboDramaTaskApiOptions & {
  runtimeOptions?: WeiboDramaRuntimeOptions;
  rpaStatus?: WeiboDramaTaskStatus;
};

export type WeiboDramaTaskSuccessReport = WeiboDramaTaskApiOptions & {
  runtimeOptions?: WeiboDramaRuntimeOptions;
  accountTaskId: number;
  workerId?: string;
  attemptCount?: number;
  externalId?: string;
  platformDramaId?: string;
  resultJson?: Record<string, unknown>;
  rpaStatus?: WeiboDramaTaskStatus;
};

export type WeiboDramaTaskErrorReport = WeiboDramaTaskApiOptions & {
  runtimeOptions?: WeiboDramaRuntimeOptions;
  accountTaskId: number;
  workerId?: string;
  attemptCount?: number;
  dramaId?: number;
  failStage: WeiboDramaTaskFailStage;
  errorMessage: string;
  resultJson?: Record<string, unknown>;
};

const defaultEndpoints: WeiboDramaTaskApiEndpoints = {
  // 账号任务列表分页查询接口
  accountTaskPage: "/dramaAiRpa/weibo/accountTask/page",
  // 领取任务接口
  claimTask: "/dramaAiRpa/weibo/rpa/claim",
  // 上报任务执行结果接口
  reportTask: "/dramaAiRpa/weibo/rpa/report",
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
    dramaId: z.coerce.number().int().positive().nullish(),
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
  workerId: z.string().trim().nullish(),
  attemptCount: z.coerce.number().int().nonnegative().nullish(),
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

function taskClient(options: WeiboDramaTaskApiOptions) {
  if (options.client) return options.client;
  if (!options.apiConfig?.baseUrl.trim()) {
    throw new Error("WEIBO_DRAMA_API_BASE_URL_REQUIRED");
  }
  return createWeiboDramaHttpClient(options.apiConfig);
}

function taskEndpoints(options: WeiboDramaTaskApiOptions): WeiboDramaTaskApiEndpoints {
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
  if (typeof value === "string") {
    return jsonRecord.parse(JSON.parse(value));
  }
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

function classifyClaimedTaskFailStage(error: unknown): WeiboDramaTaskFailStage {
  const message = error instanceof Error ? error.message : String(error);
  return /productionCost\.proofFiles|productionProof|costAllocationReport|cover|poster|licenseProof|ownership|成本|封面|海报|权属|文件|素材/i.test(
    message,
  )
    ? "UPLOAD_FILE"
    : "OTHER";
}

async function normalizeClaimedTask(options: {
  claimed: ClaimResponseData;
  listedTask?: ReadyAccountTask;
  runtimeOptions?: WeiboDramaRuntimeOptions;
}): Promise<ClaimedWeiboDramaTask> {
  const { claimed, listedTask, runtimeOptions } = options;
  const expectedAccountId = runtimeOptions?.weiboAccountId?.trim();
  const claimedAccountId = claimed.accountId?.trim();
  if (expectedAccountId && claimedAccountId && expectedAccountId !== claimedAccountId) {
    throw new Error(
      `WEIBO_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${expectedAccountId} actual=${claimedAccountId}`,
    );
  }

  const payload = parsePayloadJson(claimed.payloadJson);
  const playletPayload = recordValue(payload.weiboPlaylet);
  const playlet = {
    ...playletPayload,
    title: stringValue(playletPayload.title) ?? stringValue(payload.name),
    summary: stringValue(playletPayload.summary) ?? stringValue(payload.summary),
    episodeCount: numberValue(playletPayload.episodeCount) ?? numberValue(payload.episodeCount),
    baiduPanResourceLink:
      stringValue(playletPayload.baiduPanResourceLink) ?? stringValue(payload.baiduPanResourceLink),
    localCoverFile: undefined,
    ownershipFiles: [],
  };

  const result = claimedWeiboDramaTaskSchema.safeParse({
    accountTaskId: claimed.accountTaskId,
    workerId: stringValue(claimed.workerId),
    attemptCount: claimed.attemptCount ?? undefined,
    dramaId: listedTask?.dramaId ?? undefined,
    originalTitle: stringValue(claimed.originalTitle) ?? stringValue(listedTask?.originalTitle),
    weiboAccountId: claimedAccountId ?? listedTask?.accountId ?? expectedAccountId,
    weiboAccountName:
      stringValue(listedTask?.accountName) ?? stringValue(runtimeOptions?.weiboAccountName),
    playlet,
  });
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  throw new Error(`WEIBO_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

async function fetchReadyTasks(options: ClaimNextWeiboDramaTaskOptions) {
  const accountId = options.runtimeOptions?.weiboAccountId?.trim();
  if (!accountId) {
    throw new Error("WEIBO_DRAMA_ACCOUNT_ID_REQUIRED");
  }
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
  assertApiSuccess(payload, "WEIBO_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  return (payload.data?.data ?? []).filter(
    (task) => task.accountId === accountId && task.status === "READY",
  );
}

async function claimTask(
  options: ClaimNextWeiboDramaTaskOptions,
  accountTaskId: number,
  listedTask?: ReadyAccountTask,
) {
  const response = await withWeiboProgress(
    options.runtimeOptions ?? {},
    "领取后台任务",
    () => taskClient(options).post(taskEndpoints(options).claimTask, { accountTaskId }),
    { accountTaskId },
  );

  const payload = claimResponseSchema.parse(response);
  assertApiSuccess(payload, "WEIBO_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  if (!payload.data) {
    log(options.runtimeOptions ?? {}, "[weibo-drama] 任务已被其他实例领取，继续检查下一条", {
      accountTaskId,
    });
    return null;
  }

  try {
    if (payload.data.accountTaskId !== accountTaskId) {
      throw new Error(
        `WEIBO_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${accountTaskId} ` +
          `actual=${payload.data.accountTaskId}`,
      );
    }
    const task = await normalizeClaimedTask({
      claimed: payload.data,
      listedTask,
      runtimeOptions: options.runtimeOptions,
    });
    log(options.runtimeOptions ?? {}, "[weibo-drama] 已领取任务，开始准备素材", {
      accountTaskId,
      originalTitle: task.originalTitle,
      episodeCount: task.playlet.episodeCount,
    });
    return task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failStage = classifyClaimedTaskFailStage(error);
    log(options.runtimeOptions ?? {}, "[weibo-drama] 领取返回的任务数据校验失败", {
      accountTaskId,
      errorMessage: message,
    });
    await reportWeiboDramaTask({
      ...options,
      taskId: payload.data.accountTaskId,
      workerId: stringValue(payload.data.workerId),
      attemptCount: payload.data.attemptCount ?? undefined,
      success: false,
      failStage,
      errorMessage: message,
      resultJson: {
        accountId: options.runtimeOptions?.weiboAccountId,
        accountName: options.runtimeOptions?.weiboAccountName,
      },
    }).catch((reportError) => {
      log(
        options.runtimeOptions ?? {},
        `[weibo-drama] invalid claimed task report failed: accountTaskId=${payload.data?.accountTaskId} ` +
          `error=${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    });
    throw error;
  }
}

// 按指定任务 ID 领取 微博 上剧任务，用于人工指定或重试单个任务。
export async function claimWeiboDramaTaskByIdApi(
  options: ClaimNextWeiboDramaTaskOptions & { accountTaskId: number },
): Promise<ClaimedWeiboDramaTask | null> {
  return claimTask(options, options.accountTaskId);
}

// 查询当前账号的 READY 任务并逐条尝试领取，避免并发 worker 抢占时卡住队列。
export async function claimNextWeiboDramaTaskApi(
  options: ClaimNextWeiboDramaTaskOptions,
): Promise<ClaimedWeiboDramaTask | null> {
  const readyTasks = await fetchReadyTasks(options);
  if (readyTasks.length === 0) return null;

  log(options.runtimeOptions ?? {}, `[weibo-drama] fetched ${readyTasks.length} READY task(s)`);
  for (const listedTask of readyTasks) {
    try {
      const claimed = await claimTask(options, listedTask.id, listedTask);
      if (claimed) return claimed;
    } catch (error) {
      log(
        options.runtimeOptions ?? {},
        `[weibo-drama] task claim failed: accountTaskId=${listedTask.id} ` +
          `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

async function reportWeiboDramaTask(
  report: WeiboDramaTaskApiOptions & {
    taskId: number;
    success: boolean;
    workerId?: string;
    attemptCount?: number;
    externalId?: string;
    platformDramaId?: string;
    failStage?: WeiboDramaTaskFailStage;
    errorMessage?: string;
    resultJson?: Record<string, unknown>;
  },
) {
  const payload = reportResponseSchema.parse(
    await taskClient(report).post(taskEndpoints(report).reportTask, {
      taskId: report.taskId,
      success: report.success,
      workerId: report.workerId,
      attemptCount: report.attemptCount,
      externalId: report.externalId,
      platformDramaId: report.platformDramaId,
      failStage: report.failStage,
      errorMessage: report.errorMessage,
      resultJson: report.resultJson,
    }),
  );
  assertApiSuccess(payload, "WEIBO_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) {
    throw new Error("WEIBO_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
  }
}

export async function reportWeiboDramaTaskSuccessApi(
  report: WeiboDramaTaskSuccessReport,
): Promise<void> {
  await reportWeiboDramaTask({
    ...report,
    taskId: report.accountTaskId,
    success: true,
  });
}

export async function reportWeiboDramaTaskErrorApi(
  report: WeiboDramaTaskErrorReport,
): Promise<void> {
  if (isBrowserClosedError(report.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(report.errorMessage, {
    fallbackMessage: "微博 任务提交失败，未获取到具体错误原因",
  });
  await reportWeiboDramaTask({
    ...report,
    taskId: report.accountTaskId,
    success: false,
    failStage: report.failStage,
    errorMessage,
  });
}
