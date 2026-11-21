import { z } from "zod";
import type { DramaAiClient } from "@dramabridge/ai";
import { weiboOptions } from "./options.js";

export type WeiboDramaLoginState = "login-required" | "logged-in" | "unknown";
export type WeiboDramaTaskStatus = "READY" | "RUNNING" | "SUCCESS" | "FAILED";
export type WeiboDramaTaskFailStage =
  | "LOGIN"
  | "FILL_FORM"
  | "OTHER"
  | "RECOGNIZE_RESULT"
  | "UPLOAD_FILE"
  | "SUBMIT";
const text = z.string().trim().min(1);
const choices = (values: readonly string[], max: number) =>
  z
    .array(text.refine((value) => values.includes(value), "未知微博选项"))
    .min(1)
    .max(max)
    .refine((values) => new Set(values).size === values.length, "选项不能重复");
export const weiboDramaTaskPayloadSchema = z.object({
  title: text,
  summary: text.max(500),
  episodeCount: z.coerce.number().int().min(5).max(1000),
  baiduPanResourceLink: z.string().trim().optional(),
  collectionCategory: z.enum(weiboOptions.classify),
  audienceType: z.enum(weiboOptions.audience_type),
  subjectTypes: choices(weiboOptions.theme_type, 2),
  eraBackground: z.enum(weiboOptions.background),
  plotThemes: choices(Object.values(weiboOptions.theme_tag).flat(), 3),
  roleSettings: choices(weiboOptions.role_tag, 2),
  publishAccountName: text.optional(),
  localCoverFile: text.optional(),
  ownershipFiles: z.array(text).max(5).default([]),
});
export const claimedWeiboDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  workerId: text.optional(),
  attemptCount: z.coerce.number().int().nonnegative().optional(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: text,
  weiboAccountId: text.optional(),
  weiboAccountName: text.optional(),
  playlet: weiboDramaTaskPayloadSchema,
});
export type ClaimedWeiboDramaTask = z.infer<typeof claimedWeiboDramaTaskSchema>;
export type WeiboDramaTaskPayload = z.infer<typeof weiboDramaTaskPayloadSchema>;
export type WeiboDramaApiConfig = { baseUrl: string; timeoutMs?: number };
export type WeiboDramaRuntimeOptions = {
  signal?: AbortSignal;
  canClaimTask?: () => boolean;
  accountProfileName?: string;
  accountDir?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  weiboAccountId?: string;
  weiboAccountName?: string;
  apiConfig?: WeiboDramaApiConfig;
  localEpisodeVideoRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadWaitTimeoutMinutes?: number;
  episodeUploadFailedRetryAttempts?: number;
  taskPollIntervalMs?: number;
  failedTaskPageRetention?: "keep" | "close";
  aiClientFactory?: () => DramaAiClient;
  aiImageModel?: string;
  aiCoverGenerationRetryAttempts?: number;
  config?: { browser?: { headless?: boolean; slowMo?: number } };
  onLog?: (message: string) => void;
  ensureBaiduNetdiskResource?: (request: {
    shareText: string;
    resourceName: string;
    localEpisodeVideoRoot: string;
    episodeCount: number;
    requiredPosterImages?: number;
    requireAllDiscoveredAssets?: boolean;
    forceAssetDownload?: boolean;
    mergeOwnershipMaterials?: boolean;
    posterFallback?: { title?: string; summary: string };
  }) => Promise<unknown>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
};
export type WeiboDramaRuntimeStatus = {
  platform: "weibo-drama";
  running: boolean;
  loginState: WeiboDramaLoginState;
  activeUrl?: string;
  addUrl: string;
  loginUrl: string;
  userDataDir: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle?: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};
export type WeiboDramaRuntime = {
  getStatus: () => WeiboDramaRuntimeStatus;
  stop: () => Promise<void>;
};
