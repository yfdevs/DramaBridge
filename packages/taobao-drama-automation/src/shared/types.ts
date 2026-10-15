import { z } from "zod";
import type { DramaAiClient } from "@drama/ai";
import { TAOBAO_DRAMA_MAX_EPISODES_PER_TASK } from "./constants.js";

const requiredText = z.string().trim().min(1);

export const taobaoBatchUploadTaskSchema = z.object({
  id: requiredText,
  originalTitle: requiredText,
  title: requiredText.optional(),
  baiduPanResourceLink: requiredText,
  episodeCount: z.coerce.number().int().min(1).max(TAOBAO_DRAMA_MAX_EPISODES_PER_TASK),
  sourceFileName: requiredText.optional(),
  sourceSheet: requiredText.optional(),
  sourceRow: z.number().int().positive().optional(),
  dramaTag: requiredText.optional(),
  episodeSummaries: z.array(requiredText).optional(),
  synopsisText: requiredText.optional(),
  synopsisSource: requiredText.optional(),
  metadataGeneratedAt: requiredText.optional(),
  accountTaskId: z.coerce.number().int().positive().optional(),
  accountId: requiredText.optional(),
  accountName: requiredText.optional(),
  summary: requiredText.optional(),
  shortDramaType: z.enum(["真人实拍短剧", "AI动漫短剧", "AI仿真人短剧"]).optional(),
  shortDramaTags: z.array(requiredText).optional(),
  audience: z.enum(["男", "女"]).optional(),
  sourceCoverFile: requiredText.optional(),
  sourceCoverUrl: z.string().trim().url().optional(),
});

export const taobaoDramaTaskFailStageValues = [
  "LOGIN",
  "FILL_FORM",
  "DOWNLOAD",
  "UPLOAD_FILE",
  "SUBMIT",
  "RECOGNIZE_RESULT",
  "OTHER",
] as const;

export type TaobaoBatchUploadTask = z.infer<typeof taobaoBatchUploadTaskSchema>;
export type ClaimedTaobaoDramaTask = TaobaoBatchUploadTask & { accountTaskId: number };
export type TaobaoDramaAccount = {
  id: number;
  accountId: string;
  accountName: string;
  loginAccount?: string | null;
  rpaProfileKey?: string | null;
};
export type TaobaoDramaApiConfig = { baseUrl: string; timeoutMs?: number };
export type TaobaoDramaTaskFailStage = (typeof taobaoDramaTaskFailStageValues)[number];
export type TaobaoDramaLoginState = "login-required" | "verification-required" | "logged-in" | "unknown";
export type TaobaoBatchUploadTaskProgress = "downloading" | "uploading";

export type TaobaoCollectionMetadata = {
  title: string;
  summary: string;
  episodeCount: number;
  shortDramaType: "真人实拍短剧" | "AI动漫短剧" | "AI仿真人短剧";
  shortDramaTags: string[];
  audience: "男" | "女";
};

export type TaobaoDramaRuntimeOptions = {
  accountProfileName?: string;
  accountDir?: string;
  userDataDir?: string;
  credentialStatePath?: string;
  assetDownloadDir?: string;
  logFilePath?: string;
  logRetentionDays?: number;
  localMaterialRoot?: string;
  baiduNetdiskDownloadRetryAttempts?: number;
  episodeUploadWaitTimeoutMinutes?: number;
  taskPollIntervalMs?: number;
  closeFailedTaskPages?: boolean;
  accountId?: string;
  accountName?: string;
  apiConfig?: TaobaoDramaApiConfig;
  config?: { browser?: { executablePath?: string; headless?: boolean; slowMo?: number } };
  onLog?: (message: string) => void;
  onHumanVerificationRequired?: (details: { pages: string[] }) => Promise<void> | void;
  aiClientFactory?: () => DramaAiClient;
  aiImageModel?: string;
  aiCoverGenerationRetryAttempts?: number;
  ensureBaiduNetdiskResource?: (request: {
    shareText: string;
    resourceName: string;
    localEpisodeVideoRoot: string;
    episodeCount: number;
    requiredPosterImages?: number;
    downloadAssetMaterials?: boolean;
    forceAssetDownload?: boolean;
    requireAllDiscoveredAssets?: boolean;
    requiredMetadataTextFiles?: number;
    posterFallback?: { title?: string; summary: string };
  }) => Promise<unknown>;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: (resource: unknown) => Promise<void>;
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
