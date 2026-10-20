import { z } from "zod";
import type { DramaAiClient } from "@drama/ai";

export type KuaishouDramaLoginState = "login-required" | "logged-in" | "unknown";

export const kuaishouDramaGenderChannelValues = ["男频", "女频", "不限"] as const;
export const kuaishouDramaCategoryValues = [
  "脑洞",
  "甜宠",
  "逆袭",
  "热血",
  "复仇",
  "家庭",
  "乡村",
  "古风",
  "年代",
  "穿越",
  "悬疑",
  "武侠",
  "校园",
  "搞笑",
  "都市",
] as const;
export const kuaishouDramaPlotValues = [
  "豪门赘婿",
  "职场社畜",
  "异能奇遇",
  "麻雀变凤凰",
  "灰姑娘",
  "破镜重圆",
  "总裁追爱",
  "三教九流",
  "契约爱情",
  "总裁除恶",
  "战神归来",
  "守护家人",
  "东山再起",
  "世道人伦",
  "生活喜剧",
  "家庭伦理",
  "商海谍战",
  "江湖帮派",
  "乡村喜剧",
  "乡村文艺",
  "懵懂纯爱",
  "成长奋斗",
  "民国爱情",
  "战争谍报",
  "家宅传承",
  "军阀乱世",
  "正史传记",
  "传奇演义",
  "王朝架空",
  "门阀宅斗",
  "浪漫爱情",
  "修仙",
  "武侠",
  "西方魔幻",
  "东方魔幻",
  "重生转世",
  "穿越",
  "系统流",
  "空间流",
  "末世流",
  "灾难流",
  "星际流",
  "机甲流",
  "野村志怪",
  "探险生存",
  "诡秘悬疑",
  "警匪探案",
  "豪门儿媳",
  "其他",
] as const;
export const kuaishouDramaContentTypeValues = ["短剧", "漫剧"] as const;
export const kuaishouDramaProductionMethodValues = [
  "简笔动画",
  "小说剧",
  "AIGC剧",
  "沙雕动画",
  "3D动画",
  "2D动画",
] as const;
export const kuaishouDramaCopyrightProofTypeValues = ["自有版权", "授权版权"] as const;
export const kuaishouDramaCopyrightMaterialValues = [
  "作品登记证书",
  "短剧制作协议",
  "承诺函+现场拍摄图/短剧工程文件",
  "承诺函+可信时间戳认证",
] as const;
export const kuaishouDramaYesNoValues = ["是", "否"] as const;
export const kuaishouDramaBroadcastPathValues = ["小屏小程序", "小屏APP", "PC端"] as const;
export const kuaishouDramaPersonGenderValues = ["男", "女"] as const;
export const kuaishouDramaAuthorDeclarationValues = [
  "内容无需添加声明",
  "含AI生成内容",
] as const;
export const kuaishouDramaPublishTypeValues = [
  "付费",
  "广告",
  "广告多版本",
  "三个广告版本",
  "五个广告版本",
  "六个广告版本",
  "八个广告版本",
  "全部",
] as const;
export const kuaishouDramaSaleModeValues = [
  "全剧付费",
  "单集+全剧付费",
  "观看广告解锁",
] as const;
export const kuaishouDramaEpisodePriceValues = ["免费", "付费"] as const;

const requiredText = z.string().trim().min(1);
const dateTextSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fixedPersonnelName = "米苏";
const optionalPublishTypeSchema = z.preprocess(
  (value) =>
    value === null || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.enum(kuaishouDramaPublishTypeValues).optional(),
);

type KuaishouAdVersionConfig = {
  publishType?: KuaishouDramaPublishType | string;
  adVersionCount?: number;
  adVersionTitles?: string[];
  adVersion2Title?: string;
  adVersion3Title?: string;
  adVersion4Title?: string;
  adVersion5Title?: string;
  adVersion6Title?: string;
  adVersion7Title?: string;
  adVersion8Title?: string;
};

export function resolveKuaishouAdVersionCount(config: KuaishouAdVersionConfig): number {
  if (config.publishType === "付费") return 0;
  if (config.publishType === "三个广告版本") return 3;
  if (config.publishType === "五个广告版本") return 5;
  if (config.publishType === "六个广告版本") return 6;
  if (config.publishType === "八个广告版本") return 8;
  if (config.adVersionCount !== undefined && Number.isInteger(config.adVersionCount)) {
    return Math.max(1, config.adVersionCount);
  }
  const dynamicTitleCount = config.adVersionTitles?.length ?? 0;
  if (dynamicTitleCount > 0) return dynamicTitleCount + 1;
  if (config.publishType === "广告") return 1;
  return 8;
}

export function resolveKuaishouAdVersionTitles(config: KuaishouAdVersionConfig): string[] {
  const extraTitleCount = Math.max(0, resolveKuaishouAdVersionCount(config) - 1);
  const legacyTitles = [
    config.adVersion2Title,
    config.adVersion3Title,
    config.adVersion4Title,
    config.adVersion5Title,
    config.adVersion6Title,
    config.adVersion7Title,
    config.adVersion8Title,
  ].slice(0, extraTitleCount).flatMap((title) => title ? [title] : []);
  const isLegacyMode = [
    "三个广告版本",
    "五个广告版本",
    "六个广告版本",
    "八个广告版本",
  ].includes(config.publishType ?? "");
  if (isLegacyMode && legacyTitles.length === extraTitleCount) return legacyTitles;
  return config.adVersionTitles?.slice(0, extraTitleCount) ?? legacyTitles;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(value: Date) {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function oneYearLater(value: Date) {
  const next = new Date(value);
  next.setFullYear(next.getFullYear() + 1);
  return next;
}

const kuaishouDramaTaskBaseSchema = z.object({
  title: requiredText.max(28)
    .describe("快手短剧标题；付费版本直接使用，广告版本外层增加《》，因此原名最多 28 字"),
  episodeCount: z.coerce.number().int().min(1).max(1000)
    .describe("任务返回的总集数，用于创建单集信息槽和批量设置集数范围"),
  baiduPanResourceLink: z.string().trim().optional()
    .describe("百度网盘分享文本，包含分享链接和提取码；存在时上剧前必须下载并校验全部剧集视频"),
  publishType: optionalPublishTypeSchema
    .describe("发布模式；广告版本数量由 adVersionCount 动态控制"),
  adVersionCount: z.coerce.number().int().min(1).optional()
    .describe("需要发布的广告版本总数；第一个广告版使用主标题"),
  adVersionTitles: z.array(z.string().trim().min(1).max(28)).optional()
    .describe("第二个广告版开始的剧名，数量应为 adVersionCount - 1"),
  adVersion2Title: z.string().trim().max(28).optional(),
  adVersion3Title: z.string().trim().max(28).optional(),
  adVersion4Title: z.string().trim().max(28).optional(),
  adVersion5Title: z.string().trim().max(28).optional(),
  adVersion6Title: z.string().trim().max(28).optional(),
  adVersion7Title: z.string().trim().max(28).optional(),
  adVersion8Title: z.string().trim().max(28).optional(),
  fullDramaPriceYuan: z.coerce.number().positive().max(9999).default(4.9)
    .describe("全剧付费版本的全剧价格，单位元"),
  localCoverFile: requiredText.optional()
    .describe("运行时准备的快手 414:258 横版短剧封面"),
  summary: requiredText.min(100).max(400),
  genderChannel: z.enum(kuaishouDramaGenderChannelValues),
  categories: z.array(z.enum(kuaishouDramaCategoryValues)).min(1).max(3),
  plotTags: z.array(z.enum(kuaishouDramaPlotValues)).min(1),
  contentType: z.enum(kuaishouDramaContentTypeValues).default("漫剧"),
  productionMethod: z.enum(kuaishouDramaProductionMethodValues).default("AIGC剧"),
  isCompleted: z.enum(kuaishouDramaYesNoValues).default("是"),
  fullSceneDisplay: z.enum(kuaishouDramaYesNoValues).default("是"),
  copyrightProofType: z.enum(kuaishouDramaCopyrightProofTypeValues).default("授权版权"),
  copyrightMaterials: z
    .array(z.enum(kuaishouDramaCopyrightMaterialValues))
    .min(1)
    .default(["短剧制作协议"]),
  copyrightValidityStartDate: dateTextSchema.optional(),
  copyrightValidityEndDate: dateTextSchema.optional(),
  sublicensingRight: z.enum(kuaishouDramaYesNoValues).default("否"),
  hasRecordNumber: z.enum(kuaishouDramaYesNoValues).default("否"),
  authorDeclaration: z.enum(kuaishouDramaAuthorDeclarationValues)
    .default("含AI生成内容")
    .describe("作者声明；AIGC剧必须选择“含AI生成内容”"),
  productionYear: z.coerce.number().int().min(1900).max(2100).optional(),
  productionCostWan: z.coerce.number().positive().default(1),
  averageEpisodeDurationMinutes: z.coerce.number().positive().default(1),
  broadcastPlatform: requiredText.default("快手"),
  broadcastPaths: z
    .array(z.enum(kuaishouDramaBroadcastPathValues))
    .length(3)
    .refine((values) => new Set(values).size === values.length, {
      message: "broadcastPaths cannot contain duplicate values",
    })
    .default(["小屏小程序", "小屏APP", "PC端"]),
  broadcastDate: dateTextSchema.optional(),
  productionOrganization: requiredText,
  specialSubjectInvolved: z.enum(kuaishouDramaYesNoValues).default("否"),
}).superRefine((taskConfig, context) => {
  if (
    taskConfig.copyrightValidityStartDate &&
    taskConfig.copyrightValidityEndDate &&
    taskConfig.copyrightValidityEndDate < taskConfig.copyrightValidityStartDate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["copyrightValidityEndDate"],
      message: "copyrightValidityEndDate cannot be earlier than copyrightValidityStartDate",
    });
  }
  if (
    taskConfig.productionMethod === "AIGC剧" &&
    taskConfig.authorDeclaration !== "含AI生成内容"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorDeclaration"],
      message: "AIGC剧的作者声明必须选择含AI生成内容",
    });
  }
  const adVersionCount = resolveKuaishouAdVersionCount(taskConfig);
  if (adVersionCount > 1) {
    const titles = resolveKuaishouAdVersionTitles(taskConfig);
    if (titles.length !== adVersionCount - 1 || titles.some((title) => !title?.trim())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adVersionTitles"],
        message: `${adVersionCount}个广告版本需要填写第二至第${adVersionCount}广告版剧名`,
      });
    } else {
      const normalized = [taskConfig.title, ...titles]
        .map((title) => title!.replace(/^《+|》+$/g, "").trim());
      if (new Set(normalized).size !== adVersionCount) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adVersionTitles"],
        message: `${adVersionCount}个广告版本的剧名不能重复`,
      });
    }
  }
});

export const kuaishouDramaTaskSchema = kuaishouDramaTaskBaseSchema.transform((taskConfig) => {
  const today = new Date();
  const mainActors = [
    {
      actorName: fixedPersonnelName,
      actorGender: "男" as const,
      actorRole: "主角",
    },
    {
      actorName: fixedPersonnelName,
      actorGender: "女" as const,
      actorRole: "配角",
    },
  ];
  return {
    ...taskConfig,
    adVersionCount: resolveKuaishouAdVersionCount(taskConfig),
    adVersionTitles: resolveKuaishouAdVersionTitles(taskConfig),
    mainActors,
    directorName: fixedPersonnelName,
    directorGender: "男" as const,
    screenwriterName: fixedPersonnelName,
    screenwriterGender: "男" as const,
    producerName: fixedPersonnelName,
    producerGender: "男" as const,
    copyrightValidityStartDate: taskConfig.copyrightValidityStartDate ?? formatDate(today),
    copyrightValidityEndDate: taskConfig.copyrightValidityEndDate ?? formatDate(oneYearLater(today)),
    broadcastDate: taskConfig.broadcastDate ?? formatDate(today),
    productionYear: taskConfig.productionYear ?? today.getFullYear(),
  };
});

export type KuaishouDramaGenderChannel = z.infer<typeof kuaishouDramaTaskBaseSchema>["genderChannel"];
export type KuaishouDramaCategory = z.infer<typeof kuaishouDramaTaskBaseSchema>["categories"][number];
export type KuaishouDramaPlot = z.infer<typeof kuaishouDramaTaskBaseSchema>["plotTags"][number];
export type KuaishouDramaContentType = z.infer<typeof kuaishouDramaTaskBaseSchema>["contentType"];
export type KuaishouDramaProductionMethod = z.infer<
  typeof kuaishouDramaTaskBaseSchema
>["productionMethod"];
export type KuaishouDramaCopyrightProofType = z.infer<
  typeof kuaishouDramaTaskBaseSchema
>["copyrightProofType"];
export type KuaishouDramaCopyrightMaterial = z.infer<
  typeof kuaishouDramaTaskBaseSchema
>["copyrightMaterials"][number];
export type KuaishouDramaYesNo = z.infer<typeof kuaishouDramaTaskBaseSchema>["isCompleted"];
export type KuaishouDramaBroadcastPath = z.infer<
  typeof kuaishouDramaTaskBaseSchema
>["broadcastPaths"][number];
export type KuaishouDramaPersonGender = (typeof kuaishouDramaPersonGenderValues)[number];
export type KuaishouDramaPublishType = (typeof kuaishouDramaPublishTypeValues)[number];
export type KuaishouDramaSaleMode = (typeof kuaishouDramaSaleModeValues)[number];
export type KuaishouDramaEpisodePrice = (typeof kuaishouDramaEpisodePriceValues)[number];
export type KuaishouDramaTaskInput = z.input<typeof kuaishouDramaTaskSchema>;
export type KuaishouDramaTaskConfig = z.infer<typeof kuaishouDramaTaskSchema> & {
  /** Prepared locally at Kuaishou's 224:300 episode-cover ratio. */
  localEpisodeCoverFile?: string;
  localVariantCoverFiles?: Partial<Record<`ad-unlock-${number}`, { drama: string; episode: string }>>;
};

export type KuaishouDramaPublishVariant = {
  kind: "full-paid" | "ad-unlock" | `ad-unlock-${number}`;
  title: string;
  saleMode: Extract<KuaishouDramaSaleMode, "全剧付费" | "观看广告解锁">;
  fullDramaPriceYuan?: number;
  episodePriceRanges: Array<{
    startEpisode: number;
    endEpisode: number;
    price: KuaishouDramaEpisodePrice;
  }>;
};

export type ClaimedKuaishouDramaTask = {
  accountTaskId: number;
  dramaId?: number;
  originalTitle: string;
  kuaishouAccountId?: string;
  kuaishouAccountName?: string;
  task: KuaishouDramaTaskConfig;
};

export type KuaishouDramaApiConfig = {
  baseUrl: string;
  timeoutMs?: number;
};

export type KuaishouDramaTaskFailStage = "FILL_FORM" | "LOGIN" | "OTHER" | "UPLOAD_FILE";

export interface KuaishouDramaBrowserOptions {
  userDataDir?: string;
  headless?: boolean;
  slowMo?: number;
  keepOpenAfterRun?: boolean;
  keepOpenOnError?: boolean;
}

export type KuaishouDramaConfig = Partial<KuaishouDramaTaskInput> & {
  browser?: KuaishouDramaBrowserOptions;
  dryRun?: boolean;
  accountProfileName?: string;
  logRetentionDays?: string;
  task?: KuaishouDramaTaskInput;
  publish?: {
    submit?: boolean;
  };
};

export type KuaishouDramaRuntimeStatus = {
  platform: "kuaishou-drama";
  running: boolean;
  loginState: KuaishouDramaLoginState;
  activeUrl?: string;
  userDataDir: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle?: string;
    status: "failed" | "running" | "succeeded";
    errorMessage?: string;
    updatedAt: string;
  };
};

export type KuaishouDramaRuntimeOptions = {
  config?: KuaishouDramaConfig;
  userDataDir?: string;
  accountProfileName?: string;
  accountDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  kuaishouAccountId?: string;
  kuaishouAccountName?: string;
  apiConfig?: KuaishouDramaApiConfig;
  localEpisodeVideoRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  videoUploadTimeoutMinutes?: number;
  taskPollIntervalMs?: number;
  dailyUploadLimitResumeAt?: number;
  onDailyUploadLimitReached?: (resumeAt: number) => void;
  aiClient?: DramaAiClient;
  aiImageModel?: string;
  aiCoverGenerationRetryAttempts?: number;
  onLog?: (message: string) => void;
  /** Polled only after the initial idle page has displayed the authenticated edit form. */
  claimTask?: () => Promise<KuaishouDramaTaskInput | ClaimedKuaishouDramaTask | null>;
  reportTaskError?: (
    task: Pick<ClaimedKuaishouDramaTask, "accountTaskId"> & {
      errorMessage: string;
      failStage: KuaishouDramaTaskFailStage;
    },
  ) => Promise<void>;
  reportTaskSuccess?: (
    task: Pick<ClaimedKuaishouDramaTask, "accountTaskId"> & {
      resultJson?: Record<string, unknown>;
    },
  ) => Promise<void>;
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

export type KuaishouDramaRuntime = {
  getStatus: () => KuaishouDramaRuntimeStatus;
  stop: () => Promise<void>;
};
