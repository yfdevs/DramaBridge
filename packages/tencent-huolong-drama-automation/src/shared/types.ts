import type { DramaAiClient } from "@drama/ai";
import { z } from "zod";
import { tencentHuolongKeywordValues, tencentHuolongThemeValues } from "./constants.js";

const requiredText = z.string().trim().min(1);
const fileReference = requiredText.describe("本地文件路径或 HTTP(S) 下载地址。");

export const tencentHuolongYesNoValues = ["是", "否"] as const;
export const tencentHuolongTaskFailStageValues = [
  "LOGIN", "FILL_FORM", "UPLOAD_FILE", "SUBMIT", "OTHER",
] as const;

export const tencentHuolongTaskPayloadSchema = z.object({
  title: requiredText.max(20),
  summary: requiredText.max(150),
  episodeCount: z.coerce.number().int().min(3).max(800),
  baiduPanResourceLink: z.string().trim().optional(),
  protagonistName: z.string().trim().max(9).optional(),
  isAiRealPersonShortDrama: z.enum(tencentHuolongYesNoValues).default("否"),
  themeType: z.enum(tencentHuolongThemeValues),
  keywords: z.array(z.enum(tencentHuolongKeywordValues)).default([]),
  costAnalysisFiles: z.array(fileReference).default([]),
  copyrightProofFiles: z.array(fileReference).default([]),
  productionProcessFiles: z.array(fileReference).default([]),
}).passthrough();

export const claimedTencentHuolongDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText,
  accountId: z.string().trim().optional(),
  accountName: z.string().trim().optional(),
  playlet: tencentHuolongTaskPayloadSchema,
});

export type TencentHuolongTheme = (typeof tencentHuolongThemeValues)[number];
export type TencentHuolongKeyword = (typeof tencentHuolongKeywordValues)[number];
export type TencentHuolongTaskFailStage = (typeof tencentHuolongTaskFailStageValues)[number];
export type TencentHuolongTaskStatus = "READY" | "RUNNING" | "SUCCESS" | "FAILED";
export type TencentHuolongTaskPayload = z.infer<typeof tencentHuolongTaskPayloadSchema>;
export type ClaimedTencentHuolongDramaTask = z.infer<typeof claimedTencentHuolongDramaTaskSchema>;
export type TencentHuolongLoginState = "login-required" | "logged-in" | "unknown";

export type TencentHuolongApiConfig = { baseUrl: string; timeoutMs?: number };

export type TencentHuolongRuntimeStatus = {
  platform: "tencent-huolong-drama";
  running: boolean;
  loginState: TencentHuolongLoginState;
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

export type TencentHuolongRuntimeOptions = {
  accountProfileName?: string;
  accountDir?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  accountId?: string;
  accountName?: string;
  apiConfig?: TencentHuolongApiConfig;
  localMaterialRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadWaitTimeoutMinutes?: number;
  episodeUploadFailedRetryAttempts?: number;
  taskPollIntervalMs?: number;
  closeFailedTaskPages?: boolean;
  aiClient?: DramaAiClient;
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
    posterFallback?: { title?: string; summary: string };
  }) => Promise<unknown>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
};

export type TencentHuolongRuntime = {
  getStatus: () => TencentHuolongRuntimeStatus;
  stop: () => Promise<void>;
};
