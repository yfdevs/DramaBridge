import type { OwnershipProjectProofKind } from "@dramabridge/media-assets";
import type { DramaAiClient } from "@dramabridge/ai";
import { z } from "zod";

export type IqiyiDramaLoginState = "login-required" | "logged-in" | "unknown";
export type IqiyiDramaTaskStatus = "READY" | "RUNNING" | "SUCCESS" | "FAILED";
export type IqiyiDramaTaskFailStage =
  | "LOGIN"
  | "FILL_FORM"
  | "UPLOAD_FILE"
  | "SUBMIT"
  | "RECOGNIZE_RESULT"
  | "OTHER";

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const fileReference = requiredText.describe("本地文件路径或 HTTP(S) 下载地址。");
const iqiyiCopyrightSchema = z.object({
  productionProofFiles: z.array(fileReference).max(20).default([]),
}).strict();

export const iqiyiDramaTypeValues = ["short-drama", "comic-drama"] as const;
export const iqiyiContentSourceValues = [
  "小说改编",
  "漫画改编",
  "游戏改编",
  "影视改编",
  "原创",
] as const;
export const iqiyiVisualTypeValues = [
  "AI剧",
  "AI 2D",
  "AI 3D",
  "动态漫",
  "沙雕漫",
  "其他",
] as const;
export const iqiyiAudienceTypeValues = ["男频", "女频", "平衡"] as const;
export const iqiyiShortDramaTagValues = [
  "爱情",
  "恐怖",
  "武侠",
  "生活",
  "穿越",
  "玄幻",
  "逆袭",
  "重生",
  "刑侦",
  "预知",
  "志怪",
  "打脸虐渣",
  "现代言情",
  "都市",
  "总裁",
  "甜宠",
  "都市日常",
  "家庭伦理",
  "虐恋",
  "复仇",
  "神豪",
  "萌宝",
  "大女主",
  "其他题材",
] as const;
export const iqiyiComicDramaTagValues = [
  "大女主",
  "大男主",
  "战神",
  "废柴",
  "扮猪吃老虎",
  "悬疑",
  "科幻",
  "搞笑",
  "穿越",
  "校园",
  "恋爱",
  "末日",
  "玄幻",
  "系统",
  "诡秘",
  "逆袭",
  "异能",
  "洪荒",
  "氪金",
  "脑洞",
  "开局",
  "无限流",
  "修仙",
  "御兽",
  "无敌",
  "高武",
  "变异体",
  "规则怪谈",
  "觉醒",
] as const;

const iqiyiDramaCommonShape = {
  title: requiredText.max(30),
  summary: requiredText.min(100).max(300),
  episodeCount: z.coerce.number().int().min(1).max(2000),
  baiduPanResourceLink: optionalText,
  verticalCoverFile: fileReference.optional(),
  horizontalCoverFile: fileReference.optional(),
  productionOrganization: requiredText,
  productionCostYuan: z.coerce.number().finite().nonnegative().max(999_999_999),
};

const iqiyiComicDramaTaskPayloadSchema = z.object({
  ...iqiyiDramaCommonShape,
  dramaType: z.literal("comic-drama"),
  copyright: iqiyiCopyrightSchema,
  audienceType: z.enum(iqiyiAudienceTypeValues),
  visualType: z.enum(iqiyiVisualTypeValues),
  contentSource: z.enum(iqiyiContentSourceValues),
  secondaryCategories: z.array(z.enum(iqiyiComicDramaTagValues)).min(1),
}).strict();

const iqiyiShortDramaCommonShape = {
  ...iqiyiDramaCommonShape,
  dramaType: z.literal("short-drama"),
  copyright: iqiyiCopyrightSchema,
  audienceType: z.enum(["男频", "女频"]),
  secondaryCategories: z.array(z.enum(iqiyiShortDramaTagValues)).min(1),
};

const iqiyiPaidShortDramaTaskPayloadSchema = z.object({
  ...iqiyiShortDramaCommonShape,
  paymentStatus: z.literal("付费"),
  convertibleToFree: z.enum(["是", "否"]),
  paidStartEpisode: z.coerce.number().int().min(1),
}).strict().superRefine((value, context) => {
  if (value.paidStartEpisode <= value.episodeCount) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["paidStartEpisode"],
    message: "开始付费集不能超过总集数",
  });
});

const iqiyiFreeShortDramaTaskPayloadSchema = z.object({
  ...iqiyiShortDramaCommonShape,
  paymentStatus: z.literal("免费"),
}).strict();

export const iqiyiDramaTaskPayloadSchema = z.union([
  iqiyiComicDramaTaskPayloadSchema,
  iqiyiPaidShortDramaTaskPayloadSchema,
  iqiyiFreeShortDramaTaskPayloadSchema,
]);

export const claimedIqiyiDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText,
  iqiyiAccountId: optionalText,
  iqiyiAccountName: optionalText,
  playlet: iqiyiDramaTaskPayloadSchema,
});

export type IqiyiDramaType = z.infer<typeof iqiyiDramaTaskPayloadSchema>["dramaType"];
export type IqiyiDramaTaskPayload = z.infer<typeof iqiyiDramaTaskPayloadSchema>;
export type ClaimedIqiyiDramaTask = z.infer<typeof claimedIqiyiDramaTaskSchema>;

export type IqiyiDramaApiConfig = {
  baseUrl: string;
  timeoutMs?: number;
};

export type IqiyiDramaRuntimeStatus = {
  platform: "iqiyi-drama";
  running: boolean;
  loginState: IqiyiDramaLoginState;
  activeUrl?: string;
  shortDramaCreateUrl: string;
  comicDramaCreateUrl: string;
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
    dramaType?: IqiyiDramaType;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

export type IqiyiDramaRuntimeOptions = {
  classifyOwnershipLocally?: (file: string) => Promise<OwnershipProjectProofKind>;
  accountProfileName?: string;
  accountDir?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  iqiyiAccountId?: string;
  iqiyiAccountName?: string;
  apiConfig?: IqiyiDramaApiConfig;
  localMaterialRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  videoUploadTimeoutMinutes?: number;
  taskPollIntervalMs?: number;
  closeFailedTaskPages?: boolean;
  aiClient?: DramaAiClient;
  aiImageModel?: string;
  aiCoverGenerationRetryAttempts?: number;
  config?: {
    browser?: {
      headless?: boolean;
      slowMo?: number;
    };
  };
  onLog?: (message: string) => void;
  ensureBaiduNetdiskResource?: (request: {
    shareText: string;
    resourceName: string;
    localEpisodeVideoRoot: string;
    episodeCount: number;
    downloadEpisodeVideos?: boolean;
    forceAssetDownload?: boolean;
    requiredOwnership?: { minimumImages?: number };
    requiredOwnershipFiles?: number;
    requiredPosterImages?: number;
    requireAllDiscoveredAssets?: boolean;
    posterFallback?: { title?: string; summary: string };
  }) => Promise<unknown>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
};

export type IqiyiDramaRuntime = {
  getStatus: () => IqiyiDramaRuntimeStatus;
  stop: () => Promise<void>;
};
