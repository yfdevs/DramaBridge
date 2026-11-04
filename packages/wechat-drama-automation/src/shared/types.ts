import type { ErrorType } from "./errors.js";

export type Monetization = "IAA广告变现" | "IAP付费变现";
export type DramaType = "真人" | "数字真人" | "漫剧";
export type SubmissionIdentity = "剧目制作方" | "版权方/授权播出方";
export type QualificationType = "重点/普通微短剧" | "其他微短剧";
export type CopyrightVerificationMethod = "基于版权证明材料" | "基于版权授权关系";

export interface Config {
  originalTitle: string;
  browser?: {
    userDataDir?: string;
    headless?: boolean;
    slowMo?: number;
    keepOpenAfterRun?: boolean;
    keepOpenOnError?: boolean;
  };
  dryRun?: boolean;
  playlet: {
    name: string;
    summary: string;
    recommendation?: string;
    episodeCount: number;
    monetization: Monetization;
    previewEpisodeCount: number;
    dramaType: DramaType;
    aiContent?: boolean;
    aiProductionProofFiles?: string[];
    posters: {
      main: string;
      promotion?: string;
    };
    submissionIdentity: SubmissionIdentity;
    producerName: string;
    copyright: {
      applyProtection?: boolean;
      verificationMethod?: CopyrightVerificationMethod;
      productionProofFiles?: string[];
      licenseProofFiles?: string[];
    };
    qualification: {
      type: QualificationType;
      licenseOrRecordNumber?: string;
      proofFiles?: string[];
    };
    productionCost?: {
      amountWan: number;
      proofFiles?: string[];
    };
    otherMaterials?: string[];
  };
  publish?: {
    submit?: boolean;
  };
}

export interface RunTaskRequest {
  id?: string | number;
  channelId?: string;
}

export interface ClaimedAccountTask {
  workerId: string;
  attemptCount: number;
  accountTaskId: number;
  originalTitle: string;
  dramaId?: number;
  videoAccountId: string;
  videoAccountName: string;
  playlet: Record<string, unknown>;
  videoAccountConfig?: Record<string, unknown>;
  accountTask?: Record<string, unknown>;
}

export interface TaskRunOptions {
  signal?: AbortSignal;
  accountTaskId?: number;
  playletConfig?: Config;
  preparedEpisodeVideos?: PreparedEpisodeVideo[];
  dramaAiRpaId?: string;
  mode: "run" | "login";
  interactive: boolean;
  channelId?: string;
  videoAccountName?: string;
}

export interface PreparedEpisodeVideo {
  index: number;
  title: string;
  file: string;
  sourceFile?: string;
  originalSize?: number;
  outputSize?: number;
  transcoded?: boolean;
}

export interface BrowserCredentialCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface BrowserCredentialOrigin {
  origin: string;
  localStorage: Array<{
    name: string;
    value: string;
  }>;
}

export interface UpdateCredentialsRequest {
  cookies: BrowserCredentialCookie[];
  origins?: BrowserCredentialOrigin[];
}

export interface VodUploadObservation {
  fileId: string;
  fileName: string;
  fileSize?: number;
  reqKey?: string;
  reqTime?: number;
  observedAt: string;
}

export interface VodUploadSuccess {
  fileId: string;
  fileName: string;
  fileSize?: string;
  duration?: number;
  uploadTime?: number;
  observedAt: string;
}

export interface VodUploadFailure {
  fileId?: string;
  fileName?: string;
  errMsg: string;
  retInNode?: number;
  observedAt: string;
}

export interface VodUploadReport {
  expectedCount: number;
  observations: VodUploadObservation[];
  successes: VodUploadSuccess[];
  failures: VodUploadFailure[];
}

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface TaskRecord {
  mode: TaskRunOptions["mode"];
  channelId: string;
  accountTaskId?: number;
  dramaId?: number;
  originalTitle?: string;
  videoAccountId?: string;
  videoAccountName?: string;
  dramaAiRpaId?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  errorType?: ErrorType;
}
