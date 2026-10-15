import { z } from "zod";
import {
  DOUYIN_DRAMA_AIGC_TOOL,
  DOUYIN_DRAMA_CONTRACT_NAMES,
  DOUYIN_DRAMA_CREATOR_NAME,
  DOUYIN_DRAMA_PRODUCTION_COST_RANGE,
  DOUYIN_DRAMA_PRODUCTION_TEAM,
  DOUYIN_DRAMA_UPDATE_STATUS,
} from "./constants.js";

export const douyinDramaUpdateStatusValues = ["已完结", "连载中"] as const;
export const douyinDramaAudienceValues = ["男频", "女频", "通用"] as const;
export const douyinDramaProductionCostRangeValues = [
  "30万以下",
  "30万（含）- 80万",
  "80万及以上",
] as const;
export const douyinDramaPublishModeValues = ["自主发布", "平台发布"] as const;
export const douyinDramaMockCategoryValues = [
  "科幻末世",
  "种田",
  "年代",
  "快穿",
  "战神赘婿",
  "都市修真",
  "古风世情",
  "宫斗宅斗",
  "玄幻言情",
  "古言脑洞",
  "玄幻脑洞",
  "传统玄幻",
  "东方仙侠",
  "西方奇幻",
  "都市日常",
  "都市脑洞",
  "都市种田",
  "现言脑洞",
  "历史脑洞",
  "历史古代",
  "抗战谍战",
  "悬疑脑洞",
  "星光璀璨",
  "游戏体育",
  "豪门总裁",
  "青春甜宠",
  "职场婚恋",
  "悬疑灵异",
  "都市高武",
  "民国言情",
  "动漫衍生",
  "女频衍生",
  "男频衍生",
  "其他",
  "校园",
  "武侠",
  "剧情",
  "民国",
  "反转",
  "时空之旅",
  "悬疑",
  "家庭",
  "青春",
  "乡村",
  "古风",
  "喜剧",
  "逆袭",
] as const;

export type DouyinDramaLoginState = "login-required" | "logged-in" | "unknown";
export type DouyinDramaTaskFailStage =
  | "LOGIN"
  | "FILL_FORM"
  | "UPLOAD_FILE"
  | "SUBMIT"
  | "OTHER";

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const fileReference = requiredText.describe("本地文件路径、剧目目录相对路径或 HTTP(S) 下载地址");

export const douyinDramaRoleSchema = z.object({
  name: requiredText.max(30),
  actorName: optionalText,
  roleType: z.enum(["主角", "配角", "参演"]).optional(),
  photoFile: fileReference.optional(),
  intro: z.string().trim().min(1).max(100).optional(),
});

export const douyinDramaTaskPayloadSchema = z
  .object({
    title: requiredText.max(20),
    // Douyin is the only platform where the backend may omit the synopsis. The
    // runtime enriches an empty value from the downloaded netdisk text files.
    summary: z.string().trim().max(200).default(""),
    outsideSaleAlias: optionalText,
    outsideFreeAlias: optionalText,
    episodeCount: z.coerce.number().int().min(1).max(300),
    baiduPanResourceLink: optionalText,
    isAi: z.boolean().default(true),
    aigcTools: z.array(z.literal(DOUYIN_DRAMA_AIGC_TOOL)).max(1)
      .default([DOUYIN_DRAMA_AIGC_TOOL]),
    categories: z.array(requiredText).min(1, "分类至少选择1项"),
    audience: z.enum(douyinDramaAudienceValues),
    isSeries: z.boolean().default(false),
    isCopyrightIpAdaptation: z.boolean().default(false),
    copyrightIpName: optionalText,
    roles: z.array(douyinDramaRoleSchema).max(10).default([]),
    productionCostWan: z.coerce.number().int().refine((value) => value === 1, {
      message: "剧目制作成本固定为 1 万元",
    }).default(1),
    contractName: z.preprocess(
      (value) => typeof value === "string" && !value.trim() ? undefined : value,
      z.enum(DOUYIN_DRAMA_CONTRACT_NAMES, {
        errorMap: () => ({ message: "必须选择后台配置的抖音绑定合同" }),
      }).optional(),
    ),
    brandAccountName: optionalText,
    publishMode: z.enum(douyinDramaPublishModeValues).default("自主发布"),
    publishAccountName: optionalText,
    scheduledPublishAt: requiredText,
    unitPriceYuan: z.coerce.number().min(0.1).max(9_999).optional(),
    paidEpisodeStart: z.coerce.number().int().min(2).max(300).optional(),
    localHongguoCoverFile: fileReference.optional(),
    localDouyinCoverFile: fileReference.optional(),
    costConfigurationFiles: z.array(fileReference).min(1, "成本配置情况至少需要1个文件引用"),
    payCommitmentFiles: z.array(fileReference).default([]),
    ownershipProofFiles: z.array(fileReference).min(1, "权属文件至少需要1个文件引用"),
    nonInfringementCommitmentFiles: z.array(fileReference)
      .min(1, "不侵权承诺函至少需要1个文件引用"),
    projectScreenshotFiles: z.array(fileReference).max(5).default([]),
    submit: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.isCopyrightIpAdaptation && !value.copyrightIpName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["copyrightIpName"],
        message: "版权专区 IP 改编作品必须提供已审核通过的 IP 名称",
      });
    }
    if (value.isAi && value.aigcTools.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aigcTools"],
        message: "AI 作品必须至少关联一个 AIGC 工具",
      });
    }
    if (value.paidEpisodeStart !== undefined && value.paidEpisodeStart > value.episodeCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidEpisodeStart"],
        message: "付费起始集数不能超过总集数",
      });
    }
  })
  .transform((value) => ({
    ...value,
    updateStatus: DOUYIN_DRAMA_UPDATE_STATUS,
    productionCostRange: DOUYIN_DRAMA_PRODUCTION_COST_RANGE,
    productionOrganization: DOUYIN_DRAMA_PRODUCTION_TEAM,
    producers: [DOUYIN_DRAMA_CREATOR_NAME],
    directors: [DOUYIN_DRAMA_CREATOR_NAME],
    screenwriters: [] as string[],
  }));

export const claimedDouyinDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText,
  douyinAccountId: optionalText,
  douyinAccountName: optionalText,
  playlet: douyinDramaTaskPayloadSchema,
});

export type DouyinDramaRole = z.infer<typeof douyinDramaRoleSchema>;
export type DouyinDramaTaskPayload = z.infer<typeof douyinDramaTaskPayloadSchema>;
export type ClaimedDouyinDramaTask = z.infer<typeof claimedDouyinDramaTaskSchema>;

export type DouyinDramaApiConfig = {
  baseUrl: string;
  timeoutMs?: number;
};

export type DouyinDramaAiClient = {
  generateText: (options: {
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }) => Promise<{
    model: string;
    text: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  }>;
  generateImage?: (options: {
    model?: string;
    prompt: string;
    referenceImages?: ReadonlyArray<{
      type: "file";
      path: string;
      mimeType?: string;
      detail?: "auto" | "low" | "high";
    }>;
    size?: string;
    watermark?: boolean;
  }) => Promise<{
    model: string;
    images: Array<{ data: Uint8Array; mimeType: string }>;
  }>;
};

export type DouyinDramaRuntimeStatus = {
  platform: "douyin-drama";
  running: boolean;
  loginState: DouyinDramaLoginState;
  activeUrl?: string;
  createUrl: string;
  loginUrl: string;
  userDataDir: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

export type DouyinDramaRuntimeOptions = {
  accountProfileName?: string;
  douyinAccountId?: string;
  douyinAccountName?: string;
  apiConfig?: DouyinDramaApiConfig;
  closeFailedTaskPages?: boolean;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  localEpisodeVideoRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadReplaceAttempts?: number;
  episodeUploadBatchSize?: number;
  episodeUploadWaitTimeoutMinutes?: number;
  unitPriceYuan?: number;
  paidEpisodeStart?: number;
  taskPollIntervalMs?: number;
  config?: { browser?: { headless?: boolean; slowMo?: number } };
  onLog?: (message: string) => void;
  aiClientFactory?: () => DouyinDramaAiClient;
  aiImageModelFactory?: () => string;
  ensureBaiduNetdiskResource?: (request: {
    shareText: string;
    resourceName: string;
    localEpisodeVideoRoot: string;
    episodeCount: number;
    requiredOwnership?: { minimumImages?: number };
    requiredPosterImages?: number;
    posterFallback?: { title?: string; summary: string };
    requiredAiProductionProofFiles?: number;
    requiredMetadataTextFiles?: number;
    mergeOwnershipMaterials?: boolean;
    downloadEpisodeVideos?: boolean;
    downloadAssetMaterials?: boolean;
    forceAssetDownload?: boolean;
  }) => Promise<{ skippedExisting?: boolean } | unknown>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
};

export type DouyinDramaRuntime = {
  getStatus: () => DouyinDramaRuntimeStatus;
  stop: () => Promise<void>;
};
