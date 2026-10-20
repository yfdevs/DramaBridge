import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import { z } from "zod";
import { log } from "../shared/logger.js";
import {
  claimedTaobaoDramaTaskSchema,
  type ClaimedTaobaoDramaTask,
  type TaobaoDramaAccount,
  type TaobaoDramaRuntimeOptions,
  type TaobaoDramaTaskFailStage,
} from "../shared/types.js";
import { createTaobaoDramaHttpClient, type TaobaoDramaHttpClient } from "./http-client.js";

const requiredText = z.string().trim().min(1);
const nullableText = z.string().nullish();
const responseBaseSchema = z.object({ code: z.number(), msg: z.string().nullish() });

const readyTaskSchema = z.object({
  id: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  accountId: requiredText,
  accountName: nullableText,
  status: nullableText,
  originalTitle: nullableText,
}).passthrough();

const pageResponseSchema = responseBaseSchema.extend({
  data: z.object({
    total: z.coerce.number().int().nonnegative().optional(),
    data: z.array(readyTaskSchema),
  }).nullish(),
});

const claimDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: nullableText,
  accountId: nullableText,
  rpaProfileKey: nullableText,
  accountConfigJson: z.unknown().nullish(),
  payloadJson: z.unknown(),
});

const claimResponseSchema = responseBaseSchema.extend({ data: claimDataSchema.nullish() });
const reportResponseSchema = responseBaseSchema.extend({ data: z.boolean().nullish() });

export type TaobaoReadyAccountTask = z.infer<typeof readyTaskSchema>;
export type TaobaoClaimResponseData = z.infer<typeof claimDataSchema>;

export type TaobaoTaskReport = {
  taskId: number;
  success: boolean;
  externalId?: string;
  platformDramaId?: string;
  failStage?: TaobaoDramaTaskFailStage;
  resultJson?: Record<string, unknown>;
  errorMessage?: string;
};

function assertApiSuccess(payload: z.infer<typeof responseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

function client(apiBaseUrl: string, provided?: TaobaoDramaHttpClient) {
  return provided ?? createTaobaoDramaHttpClient({ baseUrl: apiBaseUrl });
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return recordValue(JSON.parse(value));
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
  return [...new Set(value.flatMap((item) => {
    const text = stringValue(item);
    return text ? [text] : [];
  }))];
}

function imageUrl(payload: Record<string, unknown>, key: string) {
  const images = z.array(z.object({ key: z.string().optional(), url: z.string().optional() }))
    .safeParse(payload.taobaoImages);
  return images.success
    ? images.data.find((image) => image.key === key)?.url?.trim() || undefined
    : undefined;
}

export function normalizeClaimedTaobaoDramaTask(options: {
  claimed: TaobaoClaimResponseData;
  listedTask: TaobaoReadyAccountTask;
  account: TaobaoDramaAccount;
}): ClaimedTaobaoDramaTask {
  const claimedAccountId = options.claimed.accountId?.trim() || options.listedTask.accountId;
  if (claimedAccountId !== options.account.accountId) {
    throw new Error(
      `TAOBAO_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${options.account.accountId} actual=${claimedAccountId}`,
    );
  }

  const payload = recordValue(options.claimed.payloadJson);
  const accountConfig = recordValue(options.claimed.accountConfigJson);
  const accountPlaylet = recordValue(accountConfig.taobaoPlaylet);
  const payloadPlaylet = recordValue(
    payload.taobaoPlaylet ?? payload.taobaoDrama ?? payload.playlet,
  );
  const playlet = { ...accountPlaylet, ...payloadPlaylet };
  const posters = recordValue(payload.posters);

  const result = claimedTaobaoDramaTaskSchema.safeParse({
    accountTaskId: options.claimed.accountTaskId,
    dramaId: options.listedTask.dramaId,
    originalTitle:
      stringValue(options.claimed.originalTitle) ??
      stringValue(options.listedTask.originalTitle) ??
      stringValue(payload.name) ??
      stringValue(playlet.title),
    accountId: claimedAccountId,
    accountName: options.listedTask.accountName ?? options.account.accountName,
    playlet: {
      ...playlet,
      title: stringValue(playlet.title) ?? stringValue(payload.name),
      summary: stringValue(playlet.summary) ?? stringValue(payload.summary),
      episodeCount: numberValue(playlet.episodeCount) ?? numberValue(payload.episodeCount),
      baiduPanResourceLink:
        stringValue(playlet.baiduPanResourceLink) ?? stringValue(payload.baiduPanResourceLink),
      shortDramaType:
        stringValue(playlet.shortDramaType) ?? stringValue(playlet.dramaType),
      shortDramaTags: stringArray(playlet.shortDramaTags ?? playlet.tags),
      audience: stringValue(playlet.audience) ?? stringValue(playlet.audienceType),
      sourceCoverFile: stringValue(playlet.sourceCoverFile),
      sourceCoverUrl:
        stringValue(playlet.sourceCoverUrl) ??
        stringValue(playlet.coverImageUrl) ??
        stringValue(posters.main) ??
        imageUrl(payload, "collectionCover"),
    },
  });
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  throw new Error(`TAOBAO_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

export async function fetchReadyTaobaoAccountTasksApi(options: {
  apiBaseUrl: string;
  account: TaobaoDramaAccount;
  client?: TaobaoDramaHttpClient;
}): Promise<TaobaoReadyAccountTask[]> {
  const payload = pageResponseSchema.parse(
    await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/accountTask/page", {
      page: 1,
      pageSize: 100,
      dramaId: null,
      originalTitle: null,
      accountId: options.account.accountId,
      accountName: null,
      status: "READY",
      auditStatus: null,
    }),
  );
  assertApiSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  return (payload.data?.data ?? []).filter(
    (task) => task.accountId === options.account.accountId && task.status === "READY",
  );
}

export async function claimTaobaoAccountTaskApi(options: {
  apiBaseUrl: string;
  accountTaskId: number;
  client?: TaobaoDramaHttpClient;
}): Promise<TaobaoClaimResponseData | null> {
  const payload = claimResponseSchema.parse(
    await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/rpa/claim", {
      accountTaskId: options.accountTaskId,
    }),
  );
  assertApiSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  return payload.data ?? null;
}

export async function reportTaobaoAccountTaskApi(options: {
  apiBaseUrl: string;
  report: TaobaoTaskReport;
  client?: TaobaoDramaHttpClient;
}): Promise<void> {
  if (!options.report.success && isBrowserClosedError(options.report.errorMessage)) return;
  const report = options.report.success
    ? options.report
    : {
        ...options.report,
        errorMessage: formatAutomationErrorReport(options.report.errorMessage, {
          fallbackMessage: "淘宝短剧任务提交失败，未获取到具体错误原因",
        }),
      };
  const payload = reportResponseSchema.parse(
    await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/rpa/report", report),
  );
  assertApiSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) throw new Error("TAOBAO_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
}

export async function claimNextTaobaoDramaTaskApi(options: {
  apiBaseUrl: string;
  account: TaobaoDramaAccount;
  runtimeOptions?: TaobaoDramaRuntimeOptions;
  client?: TaobaoDramaHttpClient;
}): Promise<ClaimedTaobaoDramaTask | null> {
  const readyTasks = await fetchReadyTaobaoAccountTasksApi(options);
  if (readyTasks.length === 0) return null;
  log(options.runtimeOptions ?? {}, `[taobao-drama] 获取到 ${readyTasks.length} 条 READY 任务`);
  for (const listedTask of readyTasks) {
    let claimed: TaobaoClaimResponseData | null = null;
    try {
      claimed = await claimTaobaoAccountTaskApi({
        apiBaseUrl: options.apiBaseUrl,
        accountTaskId: listedTask.id,
        client: options.client,
      });
      if (!claimed) continue;
      if (claimed.accountTaskId !== listedTask.id) {
        throw new Error(
          `TAOBAO_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${listedTask.id} actual=${claimed.accountTaskId}`,
        );
      }
      return normalizeClaimedTaobaoDramaTask({ claimed, listedTask, account: options.account });
    } catch (error) {
      if (claimed) {
        await reportTaobaoAccountTaskApi({
          apiBaseUrl: options.apiBaseUrl,
          client: options.client,
          report: {
            taskId: claimed.accountTaskId,
            success: false,
            failStage: "OTHER",
            errorMessage: error instanceof Error ? error.message : String(error),
            resultJson: {
              accountId: options.account.accountId,
              accountName: options.account.accountName,
            },
          },
        }).catch((reportError) => {
          log(
            options.runtimeOptions ?? {},
            `[taobao-drama] 无效任务回写失败：accountTaskId=${claimed?.accountTaskId} ` +
              `error=${reportError instanceof Error ? reportError.message : String(reportError)}`,
          );
        });
      }
      log(
        options.runtimeOptions ?? {},
        `[taobao-drama] 领取或解析任务失败：accountTaskId=${listedTask.id} ` +
          `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}
