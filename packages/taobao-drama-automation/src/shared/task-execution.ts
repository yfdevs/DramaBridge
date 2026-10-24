import type { TaobaoDramaTaskFailStage } from "./types.js";

export type TaobaoClaimIdentity = { accountTaskId: number; workerId: string; attemptCount: number };
export type TaobaoTaskReport = {
  taskId: number; workerId: string; attemptCount: number; success: boolean;
  failStage?: TaobaoDramaTaskFailStage; errorMessage?: string;
  externalId?: string; platformDramaId?: string; resultJson?: Record<string, unknown>;
};
export type TaobaoExecutionPhase = "claiming" | "claim-rejected" | "claimed" | "executing" |
  "review-required" | "report-pending" | "report-blocked" | "reported" | "released";
export type TaobaoSubmitCheckpoint = {
  kind: "collection" | "batch"; state: "submitting" | "confirmed";
  startEpisode?: number; endEpisode?: number;
  episodeNumbers?: number[]; collectionId?: string;
};
export type TaobaoExecutionRecord = {
  id: string; apiBaseUrl: string; accountId: string; taskId: number; workerId: string;
  ownerProcessId?: number;
  attemptCount?: number; originalTitle?: string; phase: TaobaoExecutionPhase;
  claim?: unknown; report?: TaobaoTaskReport; checkpoints: TaobaoSubmitCheckpoint[];
  errorMessage?: string; createdAt: string; updatedAt: string;
};
export interface TaobaoExecutionStore {
  save(record: TaobaoExecutionRecord): void;
  get(id: string): TaobaoExecutionRecord | undefined;
  list(apiBaseUrl: string, accountId?: string): TaobaoExecutionRecord[];
}
export type TaobaoExecutionAttention = Pick<TaobaoExecutionRecord,
  "id" | "accountId" | "taskId" | "workerId" | "attemptCount" | "originalTitle" | "phase" | "errorMessage" | "updatedAt">;

export function taobaoApiScope(apiBaseUrl: string) { return apiBaseUrl.trim().replace(/\/+$/, ""); }
export function isTaobaoExecutionUnresolved(record: TaobaoExecutionRecord) {
  return !["reported", "claim-rejected", "released"].includes(record.phase);
}
export function updateTaobaoExecution(store: TaobaoExecutionStore, record: TaobaoExecutionRecord, patch: Partial<TaobaoExecutionRecord>) {
  const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
  store.save(next);
  return next;
}
