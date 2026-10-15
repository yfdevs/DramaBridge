import type { DramaAiClient } from "@drama/ai";
import { z } from "zod";

export type BaiduDramaLoginState = "login-required" | "logged-in" | "unknown";
export type BaiduDramaTaskFailStage =
  | "LOGIN"
  | "FILL_FORM"
  | "UPLOAD_FILE"
  | "SUBMIT"
  | "RECOGNIZE_RESULT"
  | "OTHER";

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const fileReference = requiredText.describe("本地文件路径或 HTTP(S) 下载地址");
const commonCopyrightSchema = z.object({
  productionProofFiles: z.array(fileReference).default([]),
  licenseProofFiles: z.array(fileReference).default([]),
});
const commonQualificationSchema = z.object({
  type: optionalText,
  proofFiles: z.array(fileReference).default([]),
});
const commonProductionCostSchema = z.object({
  amountWan: z.coerce.number().finite().nonnegative(),
  proofFiles: z.array(fileReference).default([]),
});

export const baiduDramaGenderValues = ["男", "女"] as const;
export const baiduDramaUpdateStatusValues = ["已完结", "连载中"] as const;

export const baiduDramaPersonSchema = z.object({
  name: requiredText.max(30),
  gender: z.enum(baiduDramaGenderValues).default("男"),
  birthDate: optionalText,
  nationality: optionalText,
  company: optionalText,
});

export const baiduDramaActorSchema = z.object({
  name: requiredText.max(30),
  roleName: requiredText.max(30),
});

export const baiduDramaTaskPayloadSchema = z
  .object({
    title: requiredText.max(30),
    summary: requiredText.max(200),
    localCoverFile: fileReference.optional(),
    localLandscapeCoverFile: fileReference.optional(),
    localPortraitCoverFile: fileReference.optional(),
    episodeCount: z.coerce.number().int().min(1).max(300),
    baiduPanResourceLink: optionalText,
    audienceType: z.enum(["男频", "女频"]),
    secondaryCategory: requiredText,
    updateStatus: z.enum(baiduDramaUpdateStatusValues),
    topic: optionalText,
    isMatched: z.boolean().default(false),
    matchedIp: optionalText,
    director: baiduDramaPersonSchema,
    producers: z.array(requiredText).min(1),
    screenwriters: z.array(requiredText).min(1),
    actors: z.array(baiduDramaActorSchema).min(2),
    copyright: commonCopyrightSchema,
    qualification: commonQualificationSchema,
    productionCost: commonProductionCostSchema,
    commitmentFiles: z.array(fileReference).default([]),
    productionOrganization: requiredText.max(30),
    submit: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (value.isMatched && !value.matchedIp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matchedIp"],
        message: "撮合剧必须提供关联版权 IP",
      });
    }
  });

export const claimedBaiduDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText,
  baiduAccountId: optionalText,
  baiduAccountName: optionalText,
  playlet: baiduDramaTaskPayloadSchema,
});

export type BaiduDramaTaskPayload = z.infer<typeof baiduDramaTaskPayloadSchema>;
export type ClaimedBaiduDramaTask = z.infer<typeof claimedBaiduDramaTaskSchema>;

export type BaiduDramaApiConfig = {
  baseUrl: string;
  timeoutMs?: number;
};

export type BaiduDramaRuntimeStatus = {
  platform: "baidu-drama";
  running: boolean;
  loginState: BaiduDramaLoginState;
  activeUrl?: string;
  createUrl: string;
  loginUrl: string;
  userDataDir: string;
  taskClaimResumeAt?: number;
  lastTask?: {
    accountTaskId: number;
    originalTitle: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

export type BaiduDramaRuntimeOptions = {
  accountProfileName?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  baiduAccountId?: string;
  baiduAccountName?: string;
  apiConfig?: BaiduDramaApiConfig;
  localEpisodeVideoRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadWaitTimeoutMinutes?: number;
  taskPollIntervalMs?: number;
  taskClaimResumeAt?: number;
  onTaskClaimPaused?: (resumeAt: number) => void;
  createAiClient?: () => DramaAiClient;
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

export type BaiduDramaRuntime = {
  getStatus: () => BaiduDramaRuntimeStatus;
  stop: () => Promise<void>;
};
