import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@drama/automation-logging";
import {
  kuaishouDramaTaskSchema,
  type ClaimedKuaishouDramaTask,
  type KuaishouDramaApiConfig,
  type KuaishouDramaRuntimeOptions,
  type KuaishouDramaTaskFailStage,
} from "../shared/types.js";
import { createKuaishouDramaHttpClient, type KuaishouDramaHttpClient } from "./http-client.js";

type ApiOptions = {
  apiConfig?: KuaishouDramaApiConfig;
  client?: KuaishouDramaHttpClient;
  runtimeOptions?: KuaishouDramaRuntimeOptions;
};

const endpoints = {
  accountTaskPage: "/dramaAiRpa/kuaishou/accountTask/page",
  claimTask: "/dramaAiRpa/kuaishou/rpa/claim",
  reportTask: "/dramaAiRpa/kuaishou/rpa/report",
};
const requiredText = z.string().trim().min(1);
const nullableText = z.string().nullish();
const jsonRecord = z.record(z.unknown());
const responseBaseSchema = z.object({ code: z.number(), msg: nullableText });
const readyTaskSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    dramaId: z.coerce.number().int().positive().optional(),
    accountId: requiredText,
    accountName: nullableText,
    status: nullableText,
    originalTitle: nullableText,
  })
  .passthrough();
const pageResponseSchema = responseBaseSchema.extend({
  data: z
    .object({
      total: z.coerce.number().int().nonnegative().optional(),
      data: z.array(readyTaskSchema),
    })
    .nullish(),
});
const claimDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: nullableText,
  accountId: nullableText,
  rpaProfileKey: nullableText,
  accountConfigJson: jsonRecord.nullish(),
  payloadJson: z.unknown(),
});
const claimResponseSchema = responseBaseSchema.extend({ data: claimDataSchema.nullish() });
const reportResponseSchema = responseBaseSchema.extend({ data: z.boolean().nullish() });

type ReadyTask = z.infer<typeof readyTaskSchema>;
type ClaimData = z.infer<typeof claimDataSchema>;

function client(options: ApiOptions) {
  if (options.client) return options.client;
  if (!options.apiConfig?.baseUrl.trim()) throw new Error("KUAISHOU_DRAMA_API_BASE_URL_REQUIRED");
  return createKuaishouDramaHttpClient(options.apiConfig);
}

function assertSuccess(payload: z.infer<typeof responseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePayload(value: unknown) {
  return asRecord(typeof value === "string" ? JSON.parse(value) : value);
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const adVersionTitleFields = [
  "adVersion2Title",
  "adVersion3Title",
  "adVersion4Title",
  "adVersion5Title",
  "adVersion6Title",
  "adVersion7Title",
  "adVersion8Title",
] as const;
const adVersionSuffixes = ["二", "三", "四", "五", "六", "七", "八"] as const;

function requiredAdVersionTitleCount(publishType: string | undefined) {
  if (publishType === "付费" || publishType === "广告") return 0;
  if (publishType === "三个广告版本") return 2;
  if (publishType === "五个广告版本") return 4;
  if (publishType === "六个广告版本") return 5;
  return 7;
}

function generatedAdVersionTitle(title: string, index: number) {
  const suffix = `·${adVersionSuffixes[index]}`;
  const base = title.replace(/^《+|》+$/g, "").trim();
  return `${base.slice(0, Math.max(1, 28 - suffix.length))}${suffix}`;
}

function normalizeAdVersionTitles(
  playlet: Record<string, unknown>,
  payload: Record<string, unknown>,
  title: string,
) {
  const normalized = { ...playlet };
  const count = requiredAdVersionTitleCount(text(playlet.publishType) ?? text(payload.publishType));
  for (let index = 0; index < count; index += 1) {
    const field = adVersionTitleFields[index]!;
    normalized[field] = text(playlet[field])
      ?? text(payload[field])
      ?? generatedAdVersionTitle(title, index);
  }
  return normalized;
}

function normalizeClaimedTask(
  claimed: ClaimData,
  listedTask: ReadyTask | undefined,
  runtimeOptions: KuaishouDramaRuntimeOptions | undefined,
): ClaimedKuaishouDramaTask {
  const expectedAccountId = runtimeOptions?.kuaishouAccountId?.trim();
  const claimedAccountId = claimed.accountId?.trim();
  if (expectedAccountId && claimedAccountId && expectedAccountId !== claimedAccountId) {
    throw new Error(
      `KUAISHOU_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${expectedAccountId} ` +
        `actual=${claimedAccountId}`,
    );
  }

  const payload = parsePayload(claimed.payloadJson);
  const kuaishou = asRecord(payload.kuaishou);
  const playlet = asRecord(payload.kuaishouPlaylet ?? kuaishou.playlet);
  const productionCost = asRecord(payload.productionCost);
  const title = text(playlet.title) ?? text(payload.name);
  const normalizedPlaylet = title
    ? normalizeAdVersionTitles(playlet, payload, title)
    : playlet;
  const taskResult = kuaishouDramaTaskSchema.safeParse({
    ...normalizedPlaylet,
    title,
    summary: text(playlet.summary) ?? text(payload.summary),
    episodeCount: number(playlet.episodeCount) ?? number(payload.episodeCount),
    baiduPanResourceLink: text(playlet.baiduPanResourceLink) ?? text(payload.baiduPanResourceLink),
    localCoverFile: undefined,
    productionOrganization: text(playlet.productionOrganization) ?? text(payload.producerName),
    productionCostWan: number(playlet.productionCostWan) ?? number(productionCost.amountWan),
  });
  if (!taskResult.success) {
    const details = taskResult.error.issues
      .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
      .join("; ");
    throw new Error(`KUAISHOU_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
  }

  return {
    accountTaskId: claimed.accountTaskId,
    dramaId: listedTask?.dramaId,
    originalTitle:
      claimed.originalTitle?.trim() || listedTask?.originalTitle?.trim() || taskResult.data.title,
    kuaishouAccountId: claimedAccountId ?? listedTask?.accountId ?? expectedAccountId,
    kuaishouAccountName: listedTask?.accountName ?? runtimeOptions?.kuaishouAccountName,
    task: taskResult.data,
  };
}

async function report(
  options: ApiOptions & {
    taskId: number;
    success: boolean;
    failStage?: KuaishouDramaTaskFailStage;
    errorMessage?: string;
    resultJson?: Record<string, unknown>;
  },
) {
  const payload = reportResponseSchema.parse(
    await client(options).post(endpoints.reportTask, {
      taskId: options.taskId,
      success: options.success,
      failStage: options.failStage,
      errorMessage: options.errorMessage,
      resultJson: options.resultJson,
    }),
  );
  assertSuccess(payload, "KUAISHOU_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) {
    throw new Error("KUAISHOU_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
  }
}

async function claimById(options: ApiOptions, accountTaskId: number, listedTask?: ReadyTask) {
  const payload = claimResponseSchema.parse(
    await client(options).post(endpoints.claimTask, { accountTaskId }),
  );
  assertSuccess(payload, "KUAISHOU_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  if (!payload.data) return null;
  if (payload.data.accountTaskId !== accountTaskId) {
    throw new Error(
      `KUAISHOU_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${accountTaskId} ` +
        `actual=${payload.data.accountTaskId}`,
    );
  }
  try {
    return normalizeClaimedTask(payload.data, listedTask, options.runtimeOptions);
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

export async function claimNextKuaishouDramaTaskApi(
  options: ApiOptions,
): Promise<ClaimedKuaishouDramaTask | null> {
  const accountId = options.runtimeOptions?.kuaishouAccountId?.trim();
  if (!accountId) throw new Error("KUAISHOU_DRAMA_ACCOUNT_ID_REQUIRED");
  const pagePayload = pageResponseSchema.parse(
    await client(options).post(endpoints.accountTaskPage, {
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
  assertSuccess(pagePayload, "KUAISHOU_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  const readyTasks = (pagePayload.data?.data ?? []).filter(
    (task) => task.accountId === accountId && task.status === "READY",
  );
  for (const listedTask of readyTasks) {
    try {
      const claimed = await claimById(options, listedTask.id, listedTask);
      if (claimed) return claimed;
    } catch {
      // Another worker may have claimed it. Continue with the next READY task.
    }
  }
  return null;
}

export async function reportKuaishouDramaTaskSuccessApi(
  options: ApiOptions & {
    accountTaskId: number;
    resultJson?: Record<string, unknown>;
  },
) {
  await report({
    ...options,
    taskId: options.accountTaskId,
    success: true,
    resultJson: options.resultJson,
  });
}

export async function reportKuaishouDramaTaskErrorApi(
  options: ApiOptions & {
    accountTaskId: number;
    failStage: KuaishouDramaTaskFailStage;
    errorMessage: string;
  },
) {
  if (isBrowserClosedError(options.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(options.errorMessage, {
    fallbackMessage: "快手任务提交失败，未获取到具体错误原因",
  });
  await report({
    ...options,
    taskId: options.accountTaskId,
    success: false,
    failStage: options.failStage,
    errorMessage,
  });
}
