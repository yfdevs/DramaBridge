import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "../shared/logger.js";
import {
  taobaoBatchUploadTaskSchema,
  type ClaimedTaobaoDramaTask,
  type TaobaoDramaAccount,
  type TaobaoDramaRuntimeOptions,
} from "../shared/types.js";
import { createTaobaoDramaHttpClient, type TaobaoDramaHttpClient } from "./http-client.js";
import {
  isTaobaoExecutionUnresolved, taobaoApiScope, updateTaobaoExecution,
  type TaobaoExecutionRecord, type TaobaoExecutionStore, type TaobaoTaskReport,
} from "../shared/task-execution.js";
export type { TaobaoTaskReport } from "../shared/task-execution.js";

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
  workerId: requiredText.max(128), attemptCount: z.number().int().positive(),
  accountTaskId: z.number().int().positive(), originalTitle: z.string().nullish(),
  publishTitle: z.string().nullish(),
  accountId: z.string().nullish(), rpaProfileKey: z.string().nullish(),
  accountConfigJson: z.unknown().nullish(), payloadJson: z.unknown(),
});
const claimResponseSchema = responseBaseSchema.extend({ data: claimDataSchema.nullish() });
const reportResponseSchema = responseBaseSchema.extend({ data: z.boolean().nullish() });

type ReadyTask = z.infer<typeof readyTaskSchema>;
type ClaimData = z.infer<typeof claimDataSchema>;
export type TaobaoReadyAccountTask = ReadyTask;
export type TaobaoClaimResponseData = ClaimData;
export class TaobaoApiBusinessError extends Error {
  constructor(readonly code: number, readonly businessMessage: string, readonly action: string) {
    super(`${action}: ${businessMessage || `后端业务请求失败（${code}）`}`);
    this.name = "TaobaoApiBusinessError";
  }
}
export function isTaobaoClaimConflict(error: unknown) {
  return error instanceof TaobaoApiBusinessError && error.code === -1 &&
    /已被领取|已经被领取|已领取|状态(?:已|发生).*变更|不可领取|不允许领取|非READY|非 READY|不是READY|不是 READY/.test(error.businessMessage);
}
export function isTaobaoReportRetryable(error: unknown) {
  if (error instanceof TaobaoApiBusinessError) return false;
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  return !(status >= 400 && status < 500 && status !== 408 && status !== 429);
}

function assertSuccess(payload: z.infer<typeof responseBaseSchema>, action: string) {
  if (payload.code !== 0) throw new TaobaoApiBusinessError(payload.code, payload.msg || "", action);
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

export function normalizeClaimedTaobaoDramaTask(claimed: ClaimData, listed: ReadyTask, account: TaobaoDramaAccount, executionId: string): ClaimedTaobaoDramaTask {
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
    title: text(claimed.publishTitle) ?? text(payload.publishTitle) ?? text(playlet.title) ?? text(payload.name) ?? originalTitle,
    accountId, accountName: listed.accountName ?? account.accountName,
    baiduPanResourceLink: text(playlet.baiduPanResourceLink) ?? text(payload.baiduPanResourceLink),
    episodeCount: number(payload.episodeCount) ?? number(playlet.episodeCount),
    summary: text(playlet.summary) ?? text(payload.summary),
    shortDramaType: text(playlet.shortDramaType) ?? text(playlet.dramaType),
    shortDramaTags: texts(playlet.shortDramaTags ?? playlet.tags),
    audience: text(playlet.audience) ?? text(playlet.audienceType),
    sourceCoverFile: text(playlet.sourceCoverFile),
    sourceCoverUrl: text(playlet.sourceCoverUrl) ?? text(playlet.coverImageUrl) ?? text(posters.main) ?? imageUrl(payload, "collectionCover"),
    productionCostProofFiles: texts(productionCost.proofFiles),
  });
  if (parsed.success && parsed.data.accountTaskId) return {
    ...parsed.data, accountTaskId: claimed.accountTaskId, workerId: claimed.workerId,
    attemptCount: claimed.attemptCount, executionId,
  };
  const details = parsed.success ? "accountTaskId missing" : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`TAOBAO_DRAMA_CLAIMED_TASK_INVALID: ${details}`);
}

export async function reportTaobaoAccountTaskApi(options: { apiBaseUrl: string; report: TaobaoTaskReport; client?: TaobaoDramaHttpClient }) {
  z.object({ taskId: z.number().int().positive(), workerId: requiredText.max(128), attemptCount: z.number().int().positive(), success: z.boolean() }).parse(options.report);
  if (!options.report.success && (!options.report.failStage || !options.report.errorMessage?.trim())) {
    throw new Error("TAOBAO_DRAMA_REPORT_INVALID: 失败上报必须包含失败阶段和错误原因");
  }
  const report = options.report;
  const payload = reportResponseSchema.parse(await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/rpa/report", report));
  assertSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data !== true) throw new TaobaoApiBusinessError(-1, "后台没有确认接收结果（data 非 true），请人工核实", "TAOBAO_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
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

// Read-only reconciliation after an operator has handled an interrupted task.
export async function fetchTaobaoAccountTaskApi(options: {
  apiBaseUrl: string; accountId: string; taskId: number; client?: TaobaoDramaHttpClient;
}): Promise<TaobaoReadyAccountTask | undefined> {
  for (let page = 1; page <= 100; page++) {
    const payload = pageResponseSchema.parse(await client(options.apiBaseUrl, options.client).post(
      "/dramaAiRpa/taobao/accountTask/page", { page, pageSize: 100, accountId: options.accountId, status: null },
    ));
    assertSuccess(payload, "TAOBAO_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
    const tasks = payload.data?.data ?? [];
    const found = tasks.find((task) => task.id === options.taskId && task.accountId === options.accountId);
    if (found) return found;
    if (tasks.length < 100 || (payload.data?.total !== undefined && page * 100 >= payload.data.total)) return;
  }
  throw new Error("任务分页数量超出核实范围，请在后台核实任务后再处理");
}

export async function claimTaobaoAccountTaskApi(options: {
  apiBaseUrl: string; accountTaskId: number; workerId: string; client?: TaobaoDramaHttpClient;
  onResponse?: (response: unknown) => void;
}): Promise<TaobaoClaimResponseData> {
  requiredText.max(128).parse(options.workerId);
  const raw = await client(options.apiBaseUrl, options.client).post("/dramaAiRpa/taobao/rpa/claim", {
    accountTaskId: options.accountTaskId, workerId: options.workerId,
  });
  options.onResponse?.(raw);
  assertSuccess(responseBaseSchema.parse(raw), "TAOBAO_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  const response = claimResponseSchema.parse(raw);
  if (!response.data || response.data.accountTaskId !== options.accountTaskId || response.data.workerId !== options.workerId) {
    throw new Error("TAOBAO_DRAMA_CLAIM_UNCERTAIN: 领取响应中的任务或执行器身份不匹配，已暂停该任务，禁止上传，请核实后台领取结果。");
  }
  return response.data;
}

export async function claimNextTaobaoDramaTaskApi(options: {
  apiBaseUrl: string; account: TaobaoDramaAccount; workerId: string; executionStore: TaobaoExecutionStore;
  runtimeOptions?: TaobaoDramaRuntimeOptions; client?: TaobaoDramaHttpClient;
}): Promise<ClaimedTaobaoDramaTask | null> {
  requiredText.max(128).parse(options.workerId);
  const ready = await fetchReadyTaobaoAccountTasksApi(options);
  const store = options.executionStore;
  const blockedIds = new Set(store.list(options.apiBaseUrl, options.account.accountId).filter(isTaobaoExecutionUnresolved).map((record) => record.taskId));
  log(options.runtimeOptions ?? {}, `[taobao-drama] 获取到 ${ready.length} 条 READY 任务`, { accountId: options.account.accountId, readyTaskCount: ready.length });
  for (const listed of ready) {
    if (blockedIds.has(listed.id)) continue;
    const now = new Date().toISOString();
    let record: TaobaoExecutionRecord = {
      id: randomUUID(), apiBaseUrl: taobaoApiScope(options.apiBaseUrl), accountId: options.account.accountId,
      taskId: listed.id, workerId: options.workerId, ownerProcessId: process.pid, originalTitle: listed.originalTitle ?? undefined,
      phase: "claiming", checkpoints: [], createdAt: now, updatedAt: now,
    };
    store.save(record); // Persist before the request: a lost reply can still mean a successful claim.
    let claimed: ClaimData | null = null;
    try {
      claimed = await claimTaobaoAccountTaskApi({
        apiBaseUrl: options.apiBaseUrl,
        accountTaskId: listed.id,
        workerId: options.workerId,
        client: options.client,
        onResponse: (response) => { record = updateTaobaoExecution(store, record, { claim: response }); },
      });
      record = updateTaobaoExecution(store, record, { phase: "claimed", attemptCount: claimed.attemptCount });
      return normalizeClaimedTaobaoDramaTask(claimed, listed, options.account, record.id);
    } catch (error) {
      const message = formatAutomationErrorReport(error);
      if (error instanceof TaobaoApiBusinessError) {
        updateTaobaoExecution(store, record, { phase: "claim-rejected", errorMessage: message });
        if (isTaobaoClaimConflict(error)) continue;
        throw error;
      }
      if (claimed) {
        updateTaobaoExecution(store, record, { phase: "report-pending", errorMessage: message, report: {
          taskId: claimed.accountTaskId, workerId: claimed.workerId, attemptCount: claimed.attemptCount,
          success: false, failStage: "OTHER", errorMessage: message,
          resultJson: { accountId: options.account.accountId, accountName: options.account.accountName },
        } });
      } else {
        updateTaobaoExecution(store, record, { phase: "review-required", errorMessage:
          `领取结果待核实，禁止上传或重新领取该任务：${message}` });
      }
      throw error;
    }
  }
  return null;
}
