import { formatAutomationErrorReport, isBrowserClosedError } from "@drama/automation-logging";
import { z } from "zod";
import { log } from "../shared/logger.js";
import {
  taobaoBatchUploadTaskSchema,
  type ClaimedTaobaoDramaTask,
  type TaobaoDramaAccount,
  type TaobaoDramaRuntimeOptions,
  type TaobaoDramaTaskFailStage,
} from "../shared/types.js";
import { createTaobaoDramaHttpClient, type TaobaoDramaHttpClient } from "./http-client.js";

const requiredText = z.string().trim().min(1);
const responseBaseSchema = z.object({ code: z.number(), msg: z.string().nullish() });
const readyTaskSchema = z.object({
  id: z.coerce.number().int().positive(), dramaId: z.coerce.number().int().positive().optional(),
  accountId: requiredText, accountName: z.string().nullish(), status: z.string().nullish(),
  originalTitle: z.string().nullish(),
}).passthrough();
const pageResponseSchema = responseBaseSchema.extend({
  data: z.object({ total: z.coerce.number().int().nonnegative().optional(), data: z.array(readyTaskSchema) }).nullish(),
});
const claimDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(), originalTitle: z.string().nullish(),
  accountId: z.string().nullish(), rpaProfileKey: z.string().nullish(),
  accountConfigJson: z.unknown().nullish(), payloadJson: z.unknown(),
});
const claimResponseSchema = responseBaseSchema.extend({ data: claimDataSchema.nullish() });
const reportResponseSchema = responseBaseSchema.extend({ data: z.boolean().nullish() });

type ReadyTask = z.infer<typeof readyTaskSchema>;
type ClaimData = z.infer<typeof claimDataSchema>;
export type TaobaoReadyAccountTask = ReadyTask;
export type TaobaoClaimResponseData = ClaimData;
export type TaobaoTaskReport = {
  taskId: number; success: boolean; failStage?: TaobaoDramaTaskFailStage;
  externalId?: string; platformDramaId?: string;
  resultJson?: Record<string, unknown>; errorMessage?: string;
};

function assertSuccess(payload: z.infer<typeof responseBaseSchema>, action: string) {
  if (payload.code !== 0) throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
}
function client(apiBaseUrl: string, provided?: TaobaoDramaHttpClient) {
  return provided ?? createTaobaoDramaHttpClient({ baseUrl: apiBaseUrl });
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return record(JSON.parse(value));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function number(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
function texts(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.flatMap((item) => text(item) ? [text(item)!] : []))] : [];
}
function imageUrl(payload: Record<string, unknown>, key: string) {
  const images = z.array(z.object({ key: z.string().optional(), url: z.string().optional() })).safeParse(payload.taobaoImages);
  return images.success ? images.data.find((image) => image.key === key)?.url?.trim() || undefined : undefined;
}

export function normalizeClaimedTaobaoDramaTask(claimed: ClaimData, listed: ReadyTask, account: TaobaoDramaAccount): ClaimedTaobaoDramaTask {
  const accountId = claimed.accountId?.trim() || listed.accountId;
  if (accountId !== account.accountId) throw new Error(`TAOBAO_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${account.accountId} actual=${accountId}`);
  const payload = record(claimed.payloadJson);
  const config = record(claimed.accountConfigJson);
  const playlet = { ...record(config.taobaoPlaylet), ...record(payload.taobaoPlaylet ?? payload.taobaoDrama ?? payload.playlet) };
  const posters = record(payload.posters);
  const productionCost = {
    ...record(config.productionCost),
    ...record(playlet.productionCost),
    ...record(payload.productionCost),
  };
  const originalTitle = text(claimed.originalTitle) ?? text(listed.originalTitle) ?? text(payload.name) ?? text(playlet.title);
  const parsed = taobaoBatchUploadTaskSchema.safeParse({
    id: String(claimed.accountTaskId), accountTaskId: claimed.accountTaskId, originalTitle,
    title: text(playlet.title) ?? text(payload.name) ?? originalTitle,
    accountId, accountName: listed.accountName ?? account.accountName,
    baiduPanResourceLink: text(playlet.baiduPanResourceLink) ?? text(payload.baiduPanResourceLink),
    episodeCount: number(playlet.episodeCount) ?? number(payload.episodeCount),
    summary: text(playlet.summary) ?? text(payload.summary),
    shortDramaType: text(playlet.shortDramaType) ?? text(playlet.dramaType),
    shortDramaTags: texts(playlet.shortDramaTags ?? playlet.tags),
    audience: text(playlet.audience) ?? text(playlet.audienceType),
    sourceCoverFile: text(playlet.sourceCoverFile),
    sourceCoverUrl: text(playlet.sourceCoverUrl) ?? text(playlet.coverImageUrl) ?? text(posters.main) ?? imageUrl(payload, "collectionCover"),
    productionCostProofFiles: texts(productionCost.proofFiles),
  });
  if (parsed.success && parsed.data.accountTaskId) return parsed.data as ClaimedTaobaoDramaTask;
  const details = parsed.success ? "accountTaskId missing" : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`TAOBAO_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

export async function reportTaobaoAccountTaskApi(options: { apiBaseUrl: string; report: TaobaoTaskReport; client?: TaobaoDramaHttpClient }) {
  if (!options.report.success && isBrowserClosedError(options.report.errorMessage)) return;
  const report = options.report.success ? options.report : {
    ...options.report,
    errorMessage: formatAutomationErrorReport(options.report.errorMessage, { fallbackMessage: "淘宝短剧任务提交失败，未获取到具体错误原因" }),
  };
  const payload = reportResponseSchema.parse(await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/rpa/report", report));
  assertSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) throw new Error("TAOBAO_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
}

export async function fetchReadyTaobaoAccountTasksApi(options: {
  apiBaseUrl: string; account: TaobaoDramaAccount; client?: TaobaoDramaHttpClient;
}): Promise<TaobaoReadyAccountTask[]> {
  const page = pageResponseSchema.parse(
    await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/accountTask/page", {
      page: 1, pageSize: 100, dramaId: null, originalTitle: null,
      accountId: options.account.accountId, accountName: null, status: "READY", auditStatus: null,
    }),
  );
  assertSuccess(page, "TAOBAO_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  return (page.data?.data ?? []).filter(
    (task) => task.accountId === options.account.accountId && task.status === "READY",
  );
}

export async function claimTaobaoAccountTaskApi(options: {
  apiBaseUrl: string; accountTaskId: number; client?: TaobaoDramaHttpClient;
}): Promise<TaobaoClaimResponseData | null> {
  const response = claimResponseSchema.parse(
    await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/rpa/claim", {
      accountTaskId: options.accountTaskId,
    }),
  );
  assertSuccess(response, "TAOBAO_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  return response.data ?? null;
}

export async function claimNextTaobaoDramaTaskApi(options: {
  apiBaseUrl: string; account: TaobaoDramaAccount; runtimeOptions?: TaobaoDramaRuntimeOptions; client?: TaobaoDramaHttpClient;
}): Promise<ClaimedTaobaoDramaTask | null> {
  const ready = await fetchReadyTaobaoAccountTasksApi(options);
  log(options.runtimeOptions ?? {}, `[taobao-drama] 获取到 ${ready.length} 条 READY 任务`, { accountId: options.account.accountId, readyTaskCount: ready.length });
  for (const listed of ready) {
    let claimed: ClaimData | null = null;
    try {
      claimed = await claimTaobaoAccountTaskApi({
        apiBaseUrl: options.apiBaseUrl,
        accountTaskId: listed.id,
        client: options.client,
      });
      if (!claimed) continue;
      if (claimed.accountTaskId !== listed.id) throw new Error(`TAOBAO_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${listed.id} actual=${claimed.accountTaskId}`);
      return normalizeClaimedTaobaoDramaTask(claimed, listed, options.account);
    } catch (error) {
      if (claimed) await reportTaobaoAccountTaskApi({
        apiBaseUrl: options.apiBaseUrl, client: options.client,
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
      log(options.runtimeOptions ?? {}, `[taobao-drama] 领取或解析任务失败：accountTaskId=${listed.id} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
