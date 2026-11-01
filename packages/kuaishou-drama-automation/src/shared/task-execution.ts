import type { KuaishouDramaTaskFailStage } from "./types.js";

export type KuaishouClaimIdentity = {
  accountTaskId: number;
  workerId: string;
  attemptCount: number;
};
export type KuaishouTaskReport = {
  taskId: number;
  workerId: string;
  attemptCount: number;
  success: boolean;
  failStage?: KuaishouDramaTaskFailStage;
  errorMessage?: string;
  externalId?: string;
  platformDramaId?: string;
  resultJson?: Record<string, unknown>;
};
export type KuaishouExecutionPhase =
  | "claiming"
  | "claim-rejected"
  | "claimed"
  | "executing"
  | "review-required"
  | "report-pending"
  | "report-blocked"
  | "reported"
  | "released";
export type KuaishouSubmitCheckpoint = {
  variant: string;
  state: "submitting" | "confirmed";
};
export type KuaishouExecutionRecord = {
  id: string;
  apiBaseUrl: string;
  accountId: string;
  taskId: number;
  workerId: string;
  ownerProcessId?: number;
  attemptCount?: number;
  originalTitle?: string;
  phase: KuaishouExecutionPhase;
  claim?: unknown;
  report?: KuaishouTaskReport;
  checkpoints: KuaishouSubmitCheckpoint[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
export interface KuaishouExecutionStore {
  save(record: KuaishouExecutionRecord): void;
  get(id: string): KuaishouExecutionRecord | undefined;
  list(apiBaseUrl: string, accountId?: string): KuaishouExecutionRecord[];
}
export type KuaishouExecutionAttention = Pick<
  KuaishouExecutionRecord,
  | "id"
  | "accountId"
  | "taskId"
  | "workerId"
  | "attemptCount"
  | "originalTitle"
  | "phase"
  | "errorMessage"
  | "updatedAt"
>;

export function kuaishouApiScope(apiBaseUrl: string) {
  return apiBaseUrl.trim().replace(/\/+$/, "");
}
export function isKuaishouExecutionUnresolved(record: KuaishouExecutionRecord) {
  return !["reported", "claim-rejected", "released"].includes(record.phase);
}
export function updateKuaishouExecution(
  store: KuaishouExecutionStore,
  record: KuaishouExecutionRecord,
  patch: Partial<KuaishouExecutionRecord>,
) {
  const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
  store.save(next);
  return next;
}
