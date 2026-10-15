import { z } from "zod";
import {
  PINDUODUO_DEFAULT_COPYRIGHT_EXPIRE_TIME,
  PINDUODUO_DRAMA_CATEGORY_OPTIONS,
} from "./constants.js";

export type PinduoduoDramaLoginState = "login-required" | "logged-in" | "unknown";

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const remoteUrl = z.string().trim().url();
const accountId = z
  .union([z.string().trim().min(1), z.coerce.number().int().positive()])
  .transform(String);
const stringifiedNumber = z.union([z.string().trim().min(1), z.coerce.number()]).transform(String);
const booleanFlag = z
  .union([
    z.boolean(),
    z.literal(0),
    z.literal(1),
    z.literal("0"),
    z.literal("1"),
    z.literal("false"),
    z.literal("true"),
  ])
  .transform((value) => value === true || value === 1 || value === "1" || value === "true");

export const pinduoduoDramaTaskStatusValues = [
  "READY",
  "CLAIMED",
  "RUNNING",
  "AUDIT_PENDING",
  "AUDIT_REJECTED",
  "AUDIT_APPROVED",
  "VIDEO_UPLOAD_READY",
  "VIDEO_RESOURCE_READY",
  "VIDEO_UPLOADING",
  "SUCCESS",
  "FAILED",
] as const;

export const pinduoduoDramaTaskFailStageValues = [
  "CLAIM_TASK",
  "LOGIN",
  "OPEN_SHORTPLAY_MANAGE",
  "FILL_SHORTPLAY",
  "SUBMIT_SHORTPLAY",
  "CHECK_AUDIT",
  "PREPARE_VIDEO_RESOURCE",
  "UPLOAD_VIDEO",
  "UNKNOWN",
] as const;

export const pinduoduoDramaTaskPayloadSchema = z
  .object({
    // 短剧类型固定为 1。
    contentType: z.coerce.number().default(1).pipe(z.literal(1)).describe("短剧类型：固定 1"),
    // 子类型：1=AI仿真人剧，2=动态漫，3=解说剧。
    subContentType: z.coerce
      .number()
      .default(1)
      .pipe(z.union([z.literal(1), z.literal(2), z.literal(3)]))
      .describe("子类型：1=AI仿真人剧，2=动态漫，3=解说剧"),
    isSeriesPlay: booleanFlag.default(false).describe("是否系列剧"),
    // 版权类型：1=自有版权，2=代理转授权；默认 2。
    copyright: z.coerce
      .number()
      .default(2)
      .pipe(z.union([z.literal(1), z.literal(2)]))
      .describe("版权类型：1=自有版权，2=代理转授权；默认 2"),
    copyrightExpireTime: z.coerce
      .number()
      .int()
      .positive()
      .default(PINDUODUO_DEFAULT_COPYRIGHT_EXPIRE_TIME)
      .describe("授权到期时间戳：默认 2026-10-29 00:00:00"),
    title: requiredText.max(60).describe("短剧名称"),
    director: z.string().trim().default("明星说").describe("导演：默认明星说"),
    producer: z.string().trim().default("明星说").describe("制片人：默认明星说"),
    scriptWriter: z.string().trim().default("明星说").describe("编剧：默认明星说"),
    role: requiredText.describe("动漫主角名"),
    episodeCount: z.coerce.number().int().positive().describe("短剧集数"),
    durationMinutes: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(1)
      .describe("单集时长分钟数：默认 1"),
    durationSeconds: z.coerce
      .number()
      .int()
      .min(0)
      .max(59)
      .default(1)
      .describe("单集时长秒数：默认 1"),
    // 内容分类：1=男频，2=女频。
    cate: z.coerce
      .number()
      .default(1)
      .pipe(z.union([z.literal(1), z.literal(2)]))
      .describe("内容分类：1=男频，2=女频"),
    labelIds: z
      .array(
        z.coerce
          .number()
          .int()
          .positive()
          .refine(
            (labelId) =>
              Object.prototype.hasOwnProperty.call(
                PINDUODUO_DRAMA_CATEGORY_OPTIONS,
                String(labelId),
              ),
            "选择标签必须是 PINDUODUO_DRAMA_CATEGORY_OPTIONS 的 key",
          ),
      )
      .min(1)
      .describe("选择标签"),
    copyrightAgency: requiredText.describe("制作版权机构"),
    cost: stringifiedNumber.default("1").describe("制作成本：默认 1"),
    icpNumber: z.string().trim().default("").describe("ICP备案号：默认空字符串"),
    salaryPercent: stringifiedNumber
      .default("10")
      .describe("全部演员片酬占制作总成本百分比：默认 10"),
    majorSalaryPercent: stringifiedNumber
      .default("10")
      .describe("主要演员片酬占总片酬百分比：默认 10"),
    demoUrl: requiredText.describe("百度网盘链接"),
    summary: z.string().trim().min(300).describe("内容概要：不能少于 300 字"),
    shortplayId: optionalText,
    shortplayName: optionalText,
    coverImageUrl: remoteUrl.optional(),
    episodeVideoUrls: z.array(remoteUrl).default([]),
    authorName: optionalText,
    copyrightProofUrl: remoteUrl.optional(),
    productionProofFileUrl: remoteUrl.optional().describe("制作合同 PDF URL"),
    licenseProofFileUrl: remoteUrl.optional().describe("授权合同 PDF URL"),
    remark: z.string().trim().default("").describe("备注：默认空字符串"),
  })
  .passthrough()
  .superRefine((task, context) => {
    if (
      task.episodeCount !== undefined &&
      task.episodeVideoUrls.length > 0 &&
      task.episodeCount !== task.episodeVideoUrls.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["episodeCount"],
        message: "episodeCount must match episodeVideoUrls length when both are provided",
      });
    }
  });

export const pinduoduoDramaClaimedTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText,
  pinduoduoAccountId: accountId.optional(),
  pinduoduoAccountName: optionalText,
  playlet: pinduoduoDramaTaskPayloadSchema,
});

export const pinduoduoDramaApiConfigSchema = z.object({
  apiBaseUrl: requiredText,
  timeoutMs: z.coerce.number().int().positive().default(30000),
  headers: z.record(z.string()).optional(),
});

export type PinduoduoDramaTaskStatus = (typeof pinduoduoDramaTaskStatusValues)[number];
export type PinduoduoDramaTaskFailStage = (typeof pinduoduoDramaTaskFailStageValues)[number];
export type PinduoduoDramaTaskPayloadInput = z.input<typeof pinduoduoDramaTaskPayloadSchema>;
export type PinduoduoDramaTaskPayload = z.infer<typeof pinduoduoDramaTaskPayloadSchema>;
export type ClaimedPinduoduoDramaTask = z.infer<typeof pinduoduoDramaClaimedTaskSchema>;
export type PinduoduoDramaApiConfig = z.infer<typeof pinduoduoDramaApiConfigSchema>;

export interface PinduoduoDramaBrowserOptions {
  userDataDir?: string;
  executablePath?: string;
  headless?: boolean;
  slowMo?: number;
  keepOpenAfterRun?: boolean;
}

export interface PinduoduoDramaConfig {
  creatorUid?: string;
  api?: PinduoduoDramaApiConfig;
  browser?: PinduoduoDramaBrowserOptions;
  dryRun?: boolean;
  logRetentionDays?: number | string;
  taskPollIntervalMinutes?: number | string;
  publish?: {
    submit?: boolean;
  };
  video?: {
    localEpisodeVideoRoot?: string;
    baiduNetdiskDownloadRetryAttempts?: number | string;
    videoUploadTimeoutMinutes?: number | string;
  };
}

export type PinduoduoDramaRuntimeStatus = {
  platform: "pinduoduo-drama";
  running: boolean;
  loginState: PinduoduoDramaLoginState;
  activeUrl?: string;
  manageUrl: string;
  loginExpiredUrl: string;
  userDataDir: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  logFilePath?: string;
};

export type PinduoduoDramaRuntimeOptions = {
  config?: PinduoduoDramaConfig;
  databasePath?: string;
  userDataDir?: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  signal?: AbortSignal;
  ensureBaiduNetdiskResource?: (request: {
    shareText: string;
    resourceName: string;
    localEpisodeVideoRoot: string;
    episodeCount: number;
    downloadEpisodeVideos?: boolean;
    downloadAssetMaterials?: boolean;
    forceAssetDownload?: boolean;
    requireAllDiscoveredAssets?: boolean;
    requiredPosterImages?: number;
    posterFallback?: {
      title?: string;
      summary: string;
    };
    signal?: AbortSignal;
  }) => Promise<{ localPath?: string }>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
  onLog?: (message: string) => void;
};

export type PinduoduoDramaRuntime = {
  getStatus: () => PinduoduoDramaRuntimeStatus;
  stop: () => Promise<void>;
};
