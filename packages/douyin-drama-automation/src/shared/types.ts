import type { OwnershipProjectProofKind } from "@dramabridge/media-assets";
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
  "都市修真",
  "都市种田",
  "都市逆袭",
  "豪门总裁",
  "职场婚恋",
  "星光璀璨",
  "都市爱情",
  "都市奇幻",
  "年代种田",
  "民国传奇",
  "年代逆袭",
  "民国爱情",
  "古装亲子",
  "宫斗宅斗",
  "古装种田",
  "古装脑洞",
  "古装爱情",
  "江湖武侠",
  "东方玄幻",
  "仙侠奇缘",
  "奇幻恋爱",
  "架空奇幻",
  "末世囤货",
  "悬疑情感",
  "古装探案",
  "民俗灵异",
  "女性成长",
  "女性逆袭",
  "职场风云",
  "都市世情",
  "游戏竞技",
  "体育竞技",
  "现代亲子",
  "强者归来",
  "快穿双穿",
  "都市高武",
  "都市脑洞",
  "现言脑洞",
  "青春校园",
  "年代爱情",
  "历史脑洞",
  "历史古代",
  "玄幻脑洞",
  "西方奇幻",
  "绝境求生",
  "科幻未来",
  "悬疑推理",
  "悬疑脑洞",
  "家庭伦理",
  "都市日常",
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
  // Empty/short input is accepted here so the runtime can complete it with AI.
  intro: z.string().trim().max(100).nullish().transform(value => value ?? undefined),
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
        error: "必须选择后台配置的抖音绑定合同",
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
  classifyOwnershipLocally?: (file: string) => Promise<OwnershipProjectProofKind>;
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
  baiduNetdiskDownloadStallTimeoutMs?: number;
  baiduNetdiskProgressLogIntervalMs?: number;
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
    requiredOwnership?: {
      minimumImages?: number;
      minimumJianyingImages?: number;
    };
    requiredPosterImages?: number;
    posterFallback?: { title?: string; summary: string };
    requiredAiProductionProofFiles?: number;
    requiredMetadataTextFiles?: number;
    mergeOwnershipMaterials?: boolean;
    downloadEpisodeVideos?: boolean;
    downloadAssetMaterials?: boolean;
    forceAssetDownload?: boolean;
    signal?: AbortSignal;
    onStableEpisodeFiles?: (files: Array<{
      index: number;
      file: string;
      size: number;
      modifiedAtMs: number;
    }>) => void;
  }) => Promise<{ skippedExisting?: boolean } | unknown>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
};

export type DouyinDramaRuntime = {
  getStatus: () => DouyinDramaRuntimeStatus;
  stop: () => Promise<void>;
};
