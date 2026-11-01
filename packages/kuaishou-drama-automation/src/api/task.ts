import { randomUUID } from "node:crypto";
import {
  isKuaishouExecutionUnresolved,
  kuaishouApiScope,
  updateKuaishouExecution,
  type KuaishouExecutionRecord,
  type KuaishouTaskReport,
} from "../shared/task-execution.js";
import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import {
  kuaishouDramaTaskSchema,
  resolveKuaishouAdVersionCount,
  type ClaimedKuaishouDramaTask,
  type KuaishouDramaApiConfig,
  type KuaishouDramaRuntimeOptions,
  type KuaishouDramaTaskFailStage,
} from "../shared/types.js";
import { createKuaishouDramaHttpClient, type KuaishouDramaHttpClient } from "./http-client.js";
import { log } from "../automation/browser-session.js";

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
const jsonRecord = z.record(z.string(), z.unknown());
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
  workerId: requiredText.max(128),
  attemptCount: z.number().int().positive(),
  accountTaskId: z.number().int().positive(),
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

export class KuaishouApiBusinessError extends Error {
  constructor(
    readonly code: number,
    readonly businessMessage: string,
    readonly action: string,
  ) {
    super(`${action}: ${businessMessage || `后端业务请求失败（${code}）`}`);
    this.name = "KuaishouApiBusinessError";
  }
}
export function isKuaishouClaimConflict(error: unknown) {
  return (
    error instanceof KuaishouApiBusinessError &&
    error.code === -1 &&
    /已被领取|已经被领取|已领取|状态(?:已|发生).*变更|不可领取|不允许领取|非READY|非 READY|不是READY|不是 READY/.test(
      error.businessMessage,
    )
  );
}
export function isKuaishouReportRetryable(error: unknown) {
  if (error instanceof KuaishouApiBusinessError) return false;
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  return !(status >= 400 && status < 500 && status !== 408 && status !== 429);
}
function assertSuccess(payload: z.infer<typeof responseBaseSchema>, action: string) {
  if (payload.code !== 0)
    throw new KuaishouApiBusinessError(payload.code, payload.msg || "", action);
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
  const explicitAdVersionCount = number(playlet.adVersionCount) ?? number(payload.adVersionCount);
  const configuredTitles = [playlet.adVersionTitles, payload.adVersionTitles]
    .map(stringList)
    .find((titles) => titles !== undefined);
  const individuallyConfiguredTitleCount = adVersionTitleFields.reduce(
    (count, field, index) => ((text(playlet[field]) ?? text(payload[field])) ? index + 1 : count),
    0,
  );
  const inferredAdVersionCount = Math.max(
    configuredTitles?.reduce(
      (count, configuredTitle, index) => (configuredTitle ? index + 2 : count),
      0,
    ) ?? 0,
    individuallyConfiguredTitleCount > 0 ? individuallyConfiguredTitleCount + 1 : 0,
  );
  const adVersionCount = resolveKuaishouAdVersionCount({
    publishType,
    adVersionCount: explicitAdVersionCount ?? (inferredAdVersionCount || undefined),
    adVersionTitles: configuredTitles?.flatMap((configuredTitle) =>
      configuredTitle ? [configuredTitle] : [],
    ),
  });
  const adVersionTitles: string[] = [];
  for (let index = 0; index < Math.max(0, adVersionCount - 1); index += 1) {
    const field = adVersionTitleFields[index];
    const configuredTitle =
      configuredTitles?.[index] ??
      (field ? text(playlet[field]) : undefined) ??
      (field ? text(payload[field]) : undefined);
    if (!configuredTitle && explicitAdVersionCount !== undefined) {
      throw new Error(
        `KUAISHOU_DRAMA_AD_VERSION_TITLE_MISSING: version=${index + 2}; ` +
          `adVersionCount=${adVersionCount}`,
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
  executionId: string,
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
  const normalizedPlaylet = title ? normalizeAdVersionTitles(playlet, payload, title) : playlet;
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
    workerId: claimed.workerId,
    attemptCount: claimed.attemptCount,
    executionId,
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
    workerId: string;
    attemptCount: number;
    success: boolean;
    failStage?: KuaishouDramaTaskFailStage;
    errorMessage?: string;
    resultJson?: Record<string, unknown>;
  },
) {
  z.object({
    taskId: z.number().int().positive(),
    workerId: requiredText.max(128),
    attemptCount: z.number().int().positive(),
    success: z.boolean(),
  }).parse(options);
  if (!options.success && (!options.failStage || !options.errorMessage?.trim()))
    throw new Error("KUAISHOU_DRAMA_REPORT_INVALID: 失败上报必须包含失败阶段和错误原因");
  const payload = reportResponseSchema.parse(
    await client(options).post(endpoints.reportTask, {
      taskId: options.taskId,
      workerId: options.workerId,
      attemptCount: options.attemptCount,
      success: options.success,
      failStage: options.failStage,
      errorMessage: options.errorMessage,
      resultJson: options.resultJson,
    }),
  );
  assertSuccess(payload, "KUAISHOU_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data !== true) {
    throw new KuaishouApiBusinessError(
      -1,
      "后台未确认接收结果（data 非 true）",
      "KUAISHOU_DRAMA_ACCOUNT_TASK_REPORT_FAILED",
    );
  }
}

export async function reportKuaishouAccountTaskApi(
  options: ApiOptions & { report: KuaishouTaskReport },
) {
  await report({ ...options, ...options.report });
}

async function claimById(
  options: ApiOptions,
  accountTaskId: number,
  listedTask: ReadyTask,
  executionId: string,
) {
  const httpClient = client(options);
  const workerId = options.runtimeOptions!.workerId!;
  const raw = await httpClient.post(endpoints.claimTask, { accountTaskId, workerId });
  const store = options.runtimeOptions!.executionStore!;
  updateKuaishouExecution(store, store.get(executionId)!, { claim: raw });
  assertSuccess(responseBaseSchema.parse(raw), "KUAISHOU_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  const payload = claimResponseSchema.parse(raw);
  if (
    !payload.data ||
    payload.data.accountTaskId !== accountTaskId ||
    payload.data.workerId !== workerId
  ) {
    throw new Error(
      "KUAISHOU_DRAMA_CLAIM_UNCERTAIN: 领取响应中的任务或执行器身份不匹配，禁止上传，请核实后台领取结果",
    );
  }
  updateKuaishouExecution(store, store.get(executionId)!, {
    phase: "claimed",
    attemptCount: payload.data.attemptCount,
  });
  let claimedData = payload.data;
  if (listedTask.dramaId && httpClient.get) {
    const latest = await httpClient
      .get(endpoints.dramaDetail(listedTask.dramaId))
      .then((response) => {
        const parsed = dramaDetailResponseSchema.parse(response);
        assertSuccess(parsed, "KUAISHOU_DRAMA_DETAIL_FAILED");
        return parsed.data?.dataJson;
      })
      .catch(() => undefined);
    if (latest !== undefined)
      claimedData = {
        ...claimedData,
        payloadJson: mergeLatestDramaPayload(claimedData.payloadJson, latest),
      };
  }
  return normalizeClaimedTask(claimedData, listedTask, options.runtimeOptions, executionId);
}

export async function claimNextKuaishouDramaTaskApi(
  options: ApiOptions,
): Promise<ClaimedKuaishouDramaTask | null> {
  const accountId = options.runtimeOptions?.kuaishouAccountId?.trim();
  if (!accountId) throw new Error("KUAISHOU_DRAMA_ACCOUNT_ID_REQUIRED");
  requiredText.max(128).parse(options.runtimeOptions?.workerId);
  const store = options.runtimeOptions?.executionStore;
  if (!store) throw new Error("KUAISHOU_DRAMA_EXECUTION_STORE_REQUIRED");
  const apiBaseUrl = options.apiConfig?.baseUrl?.trim();
  if (!apiBaseUrl) throw new Error("KUAISHOU_DRAMA_API_BASE_URL_REQUIRED");
  const blockedIds = new Set(
    store
      .list(apiBaseUrl, accountId)
      .filter(isKuaishouExecutionUnresolved)
      .map((record) => record.taskId),
  );
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
  const listedTasks = pagePayload.data?.data ?? [];
  const readyTasks = listedTasks.filter(
    (task) => task.accountId === accountId && task.status === "READY",
  );
  log(
    options.runtimeOptions ?? {},
    `[kuaishou-drama] task poll result: accountId=${accountId} requestedStatus=READY ` +
      `returned=${listedTasks.length} eligible=${readyTasks.length} total=${pagePayload.data?.total ?? "unknown"}`,
  );
  for (const listedTask of readyTasks) {
    if (blockedIds.has(listedTask.id)) continue;
    const now = new Date().toISOString();
    let record: KuaishouExecutionRecord = {
      id: randomUUID(),
      apiBaseUrl: kuaishouApiScope(apiBaseUrl),
      accountId,
      taskId: listedTask.id,
      workerId: options.runtimeOptions!.workerId!,
      ownerProcessId: process.pid,
      originalTitle: listedTask.originalTitle ?? undefined,
      phase: "claiming",
      checkpoints: [],
      createdAt: now,
      updatedAt: now,
    };
    store.save(record);
    try {
      return await claimById(options, listedTask.id, listedTask, record.id);
    } catch (error) {
      record = store.get(record.id)!;
      const message = formatAutomationErrorReport(error);
      if (error instanceof KuaishouApiBusinessError) {
        updateKuaishouExecution(store, record, { phase: "claim-rejected", errorMessage: message });
        if (isKuaishouClaimConflict(error)) continue;
      } else if (record.phase === "claimed" && record.attemptCount) {
        updateKuaishouExecution(store, record, {
          phase: "report-pending",
          errorMessage: message,
          report: {
            taskId: record.taskId,
            workerId: record.workerId,
            attemptCount: record.attemptCount,
            success: false,
            failStage: "OTHER",
            errorMessage: message,
          },
        });
      } else {
        updateKuaishouExecution(store, record, {
          phase: "review-required",
          errorMessage: `领取结果待核实，禁止上传或重新领取：${message}`,
        });
      }
      log(
        options.runtimeOptions ?? {},
        `[kuaishou-drama] task claim failed: accountTaskId=${listedTask.id} error=${message}`,
      );
      throw error;
    }
  }
  return null;
}

export async function reportKuaishouDramaTaskSuccessApi(
  options: ApiOptions & {
    accountTaskId: number;
    workerId: string;
    attemptCount: number;
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
    workerId: string;
    attemptCount: number;
    failStage: KuaishouDramaTaskFailStage;
    errorMessage: string;
  },
) {
  if (
    !options.errorMessage.includes("KUAISHOU_DRAMA_PUBLISH_VARIANTS_FAILED") &&
    isBrowserClosedError(options.errorMessage)
  )
    return;
  const errorMessage = formatAutomationErrorReport(options.errorMessage, {
    fallbackMessage: "快手任务提交失败，未获取到具体错误原因",
    maxLength: 10_000,
  });
  await report({
    ...options,
    taskId: options.accountTaskId,
    success: false,
    failStage: options.failStage,
    errorMessage,
  });
}

export async function fetchKuaishouAccountTaskApi(options: {
  apiBaseUrl: string;
  accountId: string;
  taskId: number;
  client?: KuaishouDramaHttpClient;
}): Promise<ReadyTask | undefined> {
  for (let page = 1; page <= 100; page++) {
    const payload = pageResponseSchema.parse(
      await client({ apiConfig: { baseUrl: options.apiBaseUrl }, client: options.client }).post(
        "/dramaAiRpa/kuaishou/accountTask/page",
        { page, pageSize: 100, accountId: options.accountId, status: null },
      ),
    );
    assertSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
    const tasks = payload.data?.data ?? [];
    const found = tasks.find(
      (task) => task.id === options.taskId && task.accountId === options.accountId,
    );
    if (found) return found;
    if (
      tasks.length < 100 ||
      (payload.data?.total !== undefined && page * 100 >= payload.data.total)
    )
      return;
  }
  throw new Error("任务分页数量超出核实范围，请在后台核实任务后再处理");
}
