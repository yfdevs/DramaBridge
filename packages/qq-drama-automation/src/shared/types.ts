import { z } from "zod";
import type { DramaAiClient } from "@drama/ai";

export type QqDramaLoginState = "login-required" | "logged-in" | "unknown";
export type QqDramaTaskStatus = "READY" | "RUNNING" | "SUCCESS" | "FAILED";
export type QqDramaTaskFailStage =
  | "LOGIN"
  | "FILL_FORM"
  | "OTHER"
  | "RECOGNIZE_RESULT"
  | "UPLOAD_FILE"
  | "SUBMIT";

export const qqDramaTaskFailStageValues = [
  "LOGIN",
  "FILL_FORM",
  "OTHER",
  "RECOGNIZE_RESULT",
  "UPLOAD_FILE",
  "SUBMIT",
] as const;

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const fileReference = requiredText.describe("本地文件路径或 HTTP(S) 文件下载地址。");

export const qqDramaAudienceTypeValues = ["男频", "女频", "通用"] as const;
export const qqDramaUpdateStatusValues = ["已完结", "连载中"] as const;
export const qqDramaYesNoValues = ["是", "否"] as const;
export const qqDramaComicTypeValues = ["漫剧", "仿真人漫剧", "真人剧"] as const;
export const qqDramaProductionCostRangeValues = ["< 30 万", "30 ~ 80 万", "≥ 80 万"] as const;
export const qqDramaPrimaryCategoryValues = [
  "爱情",
  "都市",
  "喜剧",
  "悬疑",
  "古装",
  "奇幻",
  "玄幻",
  "科幻",
  "末世",
  "动作",
  "军事",
  "惊悚",
  "犯罪",
  "家庭",
  "亲子儿童",
  "传奇",
  "游戏竞技",
  "剧情",
] as const;
export const qqDramaSecondaryCategoryValuesByPrimary = {
  都市: ["都市职场", "都市日常", "都市律政", "豪门世家", "女性成长", "都市玄幻"],
} as const;
export const qqDramaSecondaryCategoryValues = qqDramaSecondaryCategoryValuesByPrimary["都市"];

export const qqDramaRoleSchema = z.object({
  name: requiredText.max(20).describe("角色名称。"),
  description: optionalText.describe("角色简介，选填。"),
  imageFile: fileReference.optional().describe("角色图片，支持 JPG、JPEG、PNG、BMP，选填。"),
});

const qqDramaPublishFormBaseSchema = z.object({
  title: requiredText.max(20).describe("作品名称，审核通过后不支持修改，最多 20 个字。"),
  aliases: z
    .array(requiredText)
    .default([])
    .describe("别名，用于站外渠道展示，页面以逗号分隔填写。"),
  summary: requiredText.max(200).describe("作品简介，最多 200 个字。"),
  // 受众类型：男频、女频、通用
  audienceType: z.enum(qqDramaAudienceTypeValues).describe("受众类型。"),
  localCoverFile: fileReference.describe(
    "运行时从本地资源匹配的封面图；<= 5MB 原图直传，超过时压缩，不检查比例和分辨率。",
  ),
  episodeCount: z.coerce.number().int().min(1).max(1000).describe("承诺总集数，范围 1 ~ 1000。"),
  // 更新状态：已完结、连载中
  updateStatus: z.enum(qqDramaUpdateStatusValues).describe("更新状态。"),
  // 是否 AI 作品：是、否
  isAiGenerated: z
    .enum(qqDramaYesNoValues)
    .default("是")
    .describe("是否 AI 作品；当前平台提示暂时仅支持 AI 制作漫剧上传。"),
  primaryCategory: z
    .enum(qqDramaPrimaryCategoryValues)
    .describe(
      `一级分类，按世界观、卖点、题材、剧情优先级选择，提交后不可修改。可选值：${qqDramaPrimaryCategoryValues.join("、")}。`,
    ),
  secondaryCategory: z
    .enum(qqDramaSecondaryCategoryValues)
    .optional()
    .describe(
      `二级分类，可选，页面会按一级分类联动。当前已确认「都市」二级选项：${qqDramaSecondaryCategoryValues.join("、")}。`,
    ),
  // 是否系列剧：是、否
  isSeries: z.enum(qqDramaYesNoValues).default("否").describe("是否系列剧。"),
  // 漫剧类型：漫剧、仿真人漫剧、真人剧
  comicType: z
    .enum(qqDramaComicTypeValues)
    .default("漫剧")
    .describe("漫剧类型；页面提示真人剧暂未开放上传，审核通过后不可修改。"),
  productionOrganization: requiredText.describe("制作机构，个人创作者可填「无」。"),
  producers: z.array(requiredText).min(1).describe("制片人，多个值会以逗号分隔填写。"),
  directors: z.array(requiredText).min(1).describe("导演，多个值会以逗号分隔填写。"),
  screenwriters: z.array(requiredText).default([]).describe("编剧，选填，多个值会以逗号分隔填写。"),
  roles: z
    .array(qqDramaRoleSchema)
    .default([])
    .describe("角色信息，选填；添加角色时至少填写角色名称。"),
  // 制作成本范围：< 30 万、30 ~ 80 万、≥ 80 万
  productionCostRange: z.enum(qqDramaProductionCostRangeValues).describe("制作成本范围。"),
  productionCostWan: z.coerce.number().finite().nonnegative().describe("具体成本，单位：万元。"),
  productionYear: z.coerce.number().int().min(1900).max(2100).describe("年份，例如 2026。"),
  costAllocationReportFiles: z
    .array(fileReference)
    .min(1)
    .describe("成本配置比例情况报告，支持 JPG、PNG、PDF，单个 <= 10MB。"),
  productionProofFiles: z
    .array(fileReference)
    .min(1)
    .describe("制作合同文件，支持 PDF、JPG、JPEG、PNG，单个 <= 10MB。"),
  contractName: requiredText.describe("与本剧目绑定的合同，绑定后不可更改。"),
});

export const qqDramaPublishFormSchema = qqDramaPublishFormBaseSchema.describe(
  "QQ 漫剧上剧页第 1 步「基本信息」表单。",
);

export const qqDramaTaskFieldSchema = z.object({
  label: z.string().trim().optional(),
  selector: z.string().trim().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  kind: z.enum(["text", "textarea", "select", "radio"]).default("text"),
  placeholder: z.string().trim().optional(),
  index: z.coerce.number().int().nonnegative().default(0),
});

export const qqDramaTaskFileSchema = z
  .object({
    label: z.string().trim().optional(),
    selector: z.string().trim().optional(),
    url: z.string().trim().url().optional(),
    path: z.string().trim().optional(),
    fileName: z.string().trim().optional(),
  })
  .refine((file) => Boolean(file.url || file.path), {
    message: "url or path is required.",
  });

export const qqDramaTaskPayloadSchema = z
  .object({
    title: requiredText.max(20).describe("新剧名"),
    secondVersionEnabled: z.boolean().default(false).describe("是否同时发布第二版本"),
    secondVersionTitle: z.string().trim().max(20).optional().describe("第二版本剧名，最多 20 个字"),
    summary: requiredText.max(200).describe("作品简介，最多 200 个字"),
    audienceType: z.enum(qqDramaAudienceTypeValues).describe("受众类型"),
    localCoverFile: fileReference
      .optional()
      .describe("运行时从本地资源匹配的封面图；<= 5MB 原图直传，超过时压缩，不检查比例和分辨率"),
    episodeCount: z.coerce.number().int().min(1).max(1000).describe("承诺总集数，范围 1 ~ 1000"),
    baiduPanResourceLink: z.string().trim().optional(),
    updateStatus: z.enum(qqDramaUpdateStatusValues).describe("更新状态"),
    isAiGenerated: z
      .enum(qqDramaYesNoValues)
      .default("是")
      .describe("是否 AI 作品；当前平台提示暂时仅支持 AI 制作漫剧上传"),
    primaryCategory: z
      .enum(qqDramaPrimaryCategoryValues)
      .describe(`一级分类，按世界观、卖点、题材、剧情优先级选择，提交后不可修改`),
    secondaryCategory: z
      .enum(qqDramaSecondaryCategoryValues)
      .optional()
      .describe(`二级分类，可选，页面会按一级分类联动`),
    isSeries: z.enum(qqDramaYesNoValues).default("否").describe("是否系列剧"),
    comicType: z
      .enum(qqDramaComicTypeValues)
      .default("漫剧")
      .describe("漫剧类型；页面提示真人剧暂未开放上传，审核通过后不可修改"),
    productionOrganization: requiredText.describe("制作机构，个人创作者可填「无」"),
    producers: z.array(requiredText).min(1).describe("制片人，多个值会以逗号分隔填写"),
    directors: z.array(requiredText).min(1).describe("导演，多个值会以逗号分隔填写"),
    screenwriters: z.array(requiredText).default([]).describe("编剧，选填，多个值会以逗号分隔填写"),
    roles: z
      .array(qqDramaRoleSchema)
      .default([])
      .describe("角色信息，选填；添加角色时至少填写角色名称"),
    productionCostRange: z.enum(qqDramaProductionCostRangeValues).describe("制作成本范围"),
    productionCostWan: z.coerce.number().finite().nonnegative().describe("具体成本，单位：万元"),
    productionYear: z.coerce.number().int().min(1900).max(2100).describe("年份，例如 2026"),
    costAllocationReportFiles: z
      .array(fileReference)
      .min(1, "payloadJson.productionCost.proofFiles must contain at least 1 file")
      .describe("成本配置比例情况报告，至少 1 个，支持 JPG、PNG、PDF，单个 <= 10MB"),
    productionProofFiles: z
      .array(fileReference)
      .min(1, "payloadJson.copyright.productionProofFiles must contain at least 1 file")
      .describe("制作合同文件，至少 1 个，支持 PDF、JPG、JPEG、PNG，单个 <= 10MB"),
    contractName: requiredText.describe("与本剧目绑定的合同，绑定后不可更改"),
    submit: z.boolean().default(false),
  })
  .passthrough()
  .superRefine((payload, context) => {
    if (!payload.secondVersionEnabled) return;
    if (!payload.secondVersionTitle) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secondVersionTitle"],
        message: "启用第二版本时必须填写第二版本剧名",
      });
      return;
    }
    if (payload.secondVersionTitle === payload.title) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secondVersionTitle"],
        message: "第二版本剧名不能与原剧名相同",
      });
    }
  });

export const claimedQqDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText.describe("原始剧名，用于匹配本地剧集视频目录"),
  qqAccountId: z.string().trim().optional(),
  qqAccountName: z.string().trim().optional(),
  playlet: qqDramaTaskPayloadSchema,
});

export type QqDramaTaskField = z.infer<typeof qqDramaTaskFieldSchema>;
export type QqDramaTaskFile = z.infer<typeof qqDramaTaskFileSchema>;
export type QqDramaPublishForm = z.infer<typeof qqDramaPublishFormSchema>;
export type QqDramaRole = z.infer<typeof qqDramaRoleSchema>;
export type QqDramaTaskPayload = z.infer<typeof qqDramaTaskPayloadSchema>;
export type ClaimedQqDramaTask = z.infer<typeof claimedQqDramaTaskSchema>;

export type QqDramaApiConfig = {
  baseUrl: string;
  timeoutMs?: number;
};

export type QqDramaRuntimeStatus = {
  platform: "qq-drama";
  running: boolean;
  loginState: QqDramaLoginState;
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

export type QqDramaRuntimeOptions = {
  accountProfileName?: string;
  accountDir?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  qqAccountId?: string;
  qqAccountName?: string;
  apiConfig?: QqDramaApiConfig;
  localEpisodeVideoRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadWaitTimeoutMinutes?: number;
  episodeUploadFailedRetryAttempts?: number;
  acceptSecondVersion?: boolean;
  taskPollIntervalMs?: number;
  aiClientFactory?: () => DramaAiClient;
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
    requiredOwnership?: {
      minimumImages?: number;
    };
    requiredPosterImages?: number;
    posterFallback?: { title?: string; summary: string };
  }) => Promise<unknown>;
};

export type QqDramaRuntime = {
  getStatus: () => QqDramaRuntimeStatus;
  stop: () => Promise<void>;
};
