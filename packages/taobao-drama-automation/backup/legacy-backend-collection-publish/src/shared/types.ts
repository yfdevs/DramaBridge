import type { DramaAiClient } from "@dramabridge/ai";
import { z } from "zod";

const requiredText = z.string().trim().min(1);
const fileReference = requiredText.describe("本地文件路径或 HTTP(S) 文件下载地址。");

export const taobaoDramaShortDramaTypeValues = [
  "真人实拍短剧",
  "AI动漫短剧",
  "AI仿真人短剧",
] as const;
export const taobaoDramaAudienceValues = ["男", "女"] as const;
export const taobaoDramaEraBackgroundValues = [
  "校园", "民国", "职场", "都市", "年代", "古代", "宫廷", "乡村", "架空", "荒岛", "末日",
] as const;
export const taobaoDramaAnimationContentTypeValues = [
  "AI动漫解说漫", "2D漫", "3D漫",
] as const;
export const taobaoDramaAiHumanContentTypeValues = [
  "AI真人演绎剧", "AI真人解说剧",
] as const;
export const taobaoDramaThemeTypeValues = [
  "科幻", "恐怖", "玄幻修仙", "抗战", "现代言情", "武侠", "商战", "奇幻", "古代言情", "刑侦",
  "都市修仙", "权谋", "悬疑推理", "魔幻惊悚", "正能量",
] as const;
export const taobaoDramaCorePlotValues = [
  "玄学", "虐渣打脸", "豪门", "传承觉醒", "团宠", "娱乐圈", "逆袭", "异能", "宅斗", "鉴宝",
  "女性成长", "扮猪吃虎", "重生", "闪婚", "穿越", "先婚后爱", "破镜重圆", "青梅竹马",
  "真假千金", "虐恋", "宫斗", "穿书", "甜宠", "家庭伦理", "系统", "求生", "复仇", "马甲",
  "追妻火葬场", "暗恋", "替身", "古穿今", "带球跑", "创业", "契约婚姻", "身份反转", "年下",
  "替嫁", "相爱相杀", "失忆", "医术",
] as const;
export const taobaoDramaRoleSettingValues = [
  "兵王", "小人物", "中老年", "大女主", "赘婿", "王妃", "嫡女", "反派", "萌宝", "女帝", "神豪",
  "弃少", "高手下山", "强者归来", "战神", "霸总", "黑道", "神医", "娇妻",
] as const;
export const taobaoDramaPropertyTagValues = [
  ...taobaoDramaEraBackgroundValues,
  ...taobaoDramaAnimationContentTypeValues,
  ...taobaoDramaAiHumanContentTypeValues,
  ...taobaoDramaThemeTypeValues,
  ...taobaoDramaCorePlotValues,
  ...taobaoDramaRoleSettingValues,
] as const;

export const taobaoDramaTaskFailStageValues = [
  "LOGIN",
  "FILL_FORM",
  "UPLOAD_FILE",
  "SUBMIT",
  "RECOGNIZE_RESULT",
  "OTHER",
] as const;

export const taobaoDramaTaskPayloadSchema = z.object({
  title: requiredText,
  summary: requiredText,
  episodeCount: z.coerce.number().int().min(1),
  baiduPanResourceLink: z.string().trim().optional(),
  shortDramaType: z.enum(taobaoDramaShortDramaTypeValues),
  shortDramaTags: z.array(z.enum(taobaoDramaPropertyTagValues)).min(1),
  audience: z.enum(taobaoDramaAudienceValues),
  sourceCoverFile: fileReference.optional(),
  sourceCoverUrl: z.string().trim().url().optional(),
}).passthrough().superRefine((task, context) => {
  const selected = new Set(task.shortDramaTags);
  const animationTypes = taobaoDramaAnimationContentTypeValues.filter((value) => selected.has(value));
  const aiHumanTypes = taobaoDramaAiHumanContentTypeValues.filter((value) => selected.has(value));
  if (task.shortDramaType === "真人实拍短剧" && (animationTypes.length || aiHumanTypes.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shortDramaTags"],
      message: "真人实拍短剧不能选择AI动漫或AI真人内容类型标签",
    });
  }
  if (task.shortDramaType === "AI动漫短剧" && animationTypes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shortDramaTags"],
      message: "AI动漫短剧必须选择AI动漫解说漫、2D漫或3D漫",
    });
  }
  if (task.shortDramaType === "AI仿真人短剧" && aiHumanTypes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shortDramaTags"],
      message: "AI仿真人短剧必须选择AI真人演绎剧或AI真人解说剧",
    });
  }
});

export const claimedTaobaoDramaTaskSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  dramaId: z.coerce.number().int().positive().optional(),
  originalTitle: requiredText,
  accountId: requiredText.optional(),
  accountName: requiredText.optional(),
  playlet: taobaoDramaTaskPayloadSchema,
});

export type TaobaoDramaAudience = (typeof taobaoDramaAudienceValues)[number];
export type TaobaoDramaTaskFailStage = (typeof taobaoDramaTaskFailStageValues)[number];
export type TaobaoDramaTaskPayload = z.infer<typeof taobaoDramaTaskPayloadSchema>;
export type ClaimedTaobaoDramaTask = z.infer<typeof claimedTaobaoDramaTaskSchema>;
export type TaobaoDramaLoginState = "login-required" | "verification-required" | "logged-in" | "unknown";

export type TaobaoDramaAccount = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};

export type TaobaoDramaApiConfig = { baseUrl: string; timeoutMs?: number };

export type TaobaoDramaRuntimeOptions = {
  accountProfileName?: string;
  accountDir?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  accountId?: string;
  accountName?: string;
  apiConfig?: TaobaoDramaApiConfig;
  localMaterialRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadWaitTimeoutMinutes?: number;
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
};

export type TaobaoDramaRuntimeStatus = {
  platform: "taobao-drama";
  running: boolean;
  loginState: TaobaoDramaLoginState;
  activeUrl?: string;
  collectionCreateUrl: string;
  batchPublishUrl: string;
  loginUrl: string;
  userDataDir: string;
  accountProfileName?: string;
  lastTask?: {
    accountTaskId: number;
    originalTitle?: string;
    status: "running" | "succeeded" | "failed";
    errorMessage?: string;
    updatedAt: string;
  };
};

export type TaobaoDramaRuntime = {
  getStatus: () => TaobaoDramaRuntimeStatus;
  stop: () => Promise<void>;
};
