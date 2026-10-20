import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@drama/automation-logging";
import {
  kuaishouDramaTaskSchema,
  resolveKuaishouAdVersionCount,
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
  dramaDetail: (dramaId: number) => `/dramaAiRpa/detail/${dramaId}`,
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
const dramaDetailResponseSchema = responseBaseSchema.extend({
  data: z.object({ dataJson: z.unknown() }).passthrough().nullish(),
});
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

function mergeLatestDramaPayload(snapshotValue: unknown, latestValue: unknown) {
  const snapshot = parsePayload(snapshotValue);
  const latest = parsePayload(latestValue);
  const snapshotKuaishou = asRecord(snapshot.kuaishou);
  const latestKuaishou = asRecord(latest.kuaishou);
  const snapshotPlaylet = asRecord(snapshot.kuaishouPlaylet ?? snapshotKuaishou.playlet);
  const latestPlaylet = asRecord(latest.kuaishouPlaylet ?? latestKuaishou.playlet);
  return {
    ...snapshot,
    ...latest,
    kuaishouPlaylet: {
      ...snapshotPlaylet,
      ...latestPlaylet,
    },
  };
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => text(item));
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => text(item));
  } catch {
    // Some backend serializers return a delimited string instead of a JSON array.
  }
  return value.split(/[,，、\n]/u).map((item) => text(item));
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

function generatedAdVersionTitle(title: string, index: number) {
  const suffix = `·${adVersionSuffixes[index] ?? index + 2}`;
  const base = title.replace(/^《+|》+$/g, "").trim();
  return `${base.slice(0, Math.max(1, 28 - suffix.length))}${suffix}`;
}

function normalizeAdVersionTitles(
  playlet: Record<string, unknown>,
  payload: Record<string, unknown>,
  title: string,
) {
  const normalized = { ...playlet };
  const publishType = text(playlet.publishType) ?? text(payload.publishType);
  const explicitAdVersionCount = number(playlet.adVersionCount)
    ?? number(payload.adVersionCount);
  const configuredTitles = [playlet.adVersionTitles, payload.adVersionTitles]
    .map(stringList)
    .find((titles) => titles !== undefined);
  const individuallyConfiguredTitleCount = adVersionTitleFields.reduce((count, field, index) => (
    text(playlet[field]) ?? text(payload[field]) ? index + 1 : count
  ), 0);
  const inferredAdVersionCount = Math.max(
    configuredTitles?.reduce((count, configuredTitle, index) => (
      configuredTitle ? index + 2 : count
    ), 0) ?? 0,
    individuallyConfiguredTitleCount > 0 ? individuallyConfiguredTitleCount + 1 : 0,
  );
  const adVersionCount = resolveKuaishouAdVersionCount({
    publishType,
    adVersionCount: explicitAdVersionCount ?? (inferredAdVersionCount || undefined),
    adVersionTitles: configuredTitles?.flatMap(
      (configuredTitle) => configuredTitle ? [configuredTitle] : [],
    ),
  });
  const adVersionTitles: string[] = [];
  for (let index = 0; index < Math.max(0, adVersionCount - 1); index += 1) {
    const field = adVersionTitleFields[index];
    const configuredTitle = configuredTitles?.[index]
      ?? (field ? text(playlet[field]) : undefined)
      ?? (field ? text(payload[field]) : undefined);
    if (!configuredTitle && explicitAdVersionCount !== undefined) {
      throw new Error(
        `KUAISHOU_DRAMA_AD_VERSION_TITLE_MISSING: version=${index + 2}; `
          + `adVersionCount=${adVersionCount}`,
      );
    }
    adVersionTitles.push(configuredTitle ?? generatedAdVersionTitle(title, index));
  }
  normalized.publishType = publishType;
  normalized.adVersionCount = adVersionCount > 0 ? adVersionCount : undefined;
  normalized.adVersionTitles = adVersionTitles;
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
  const httpClient = client(options);
  const payload = claimResponseSchema.parse(
    await httpClient.post(endpoints.claimTask, { accountTaskId }),
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
    let claimedData = payload.data;
    if (listedTask?.dramaId && httpClient.get) {
      const latestPayload = await httpClient.get(endpoints.dramaDetail(listedTask.dramaId))
        .then((response) => dramaDetailResponseSchema.parse(response))
        .then((response) => response.data?.dataJson)
        .catch(() => undefined);
      if (latestPayload !== undefined) {
        claimedData = {
          ...claimedData,
          payloadJson: mergeLatestDramaPayload(claimedData.payloadJson, latestPayload),
        };
      }
    }
    return normalizeClaimedTask(claimedData, listedTask, options.runtimeOptions);
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
