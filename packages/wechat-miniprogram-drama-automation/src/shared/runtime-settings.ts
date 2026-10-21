export interface WechatMiniProgramRuntimeSettings {
  apiBaseUrl: string;
  taskApiPrefix: string;
  mockAssetRoot: string;
  localEpisodeVideoRoot: string;
  closeFailedTaskPages: string;
  runDataDir: string;
  logRetentionDays: string;
  workerEmptyClaimDelaySeconds: string;
  workerSlowEmptyClaimThreshold: string;
  workerSlowEmptyClaimDelaySeconds: string;
  videoAccountSyncIntervalSeconds: string;
  idlePageRefreshIntervalSeconds: string;
  idlePageRefreshTimeoutSeconds: string;
  idlePageRefreshJitterSeconds: string;
  basicInfoStepTimeoutSeconds: string;
  remoteFileDownloadTimeoutSeconds: string;
  baiduNetdiskDownloadRetryAttempts: string;
  mergeOwnershipMaterials: string;
  materialPreparationConcurrency: string;
  taskPrefetchPerAccount: string;
  videoTranscodeConcurrency: string;
  videoTranscodeThreadsPerJob: string;
  episodeVideoMaxFileMegabytes: string;
  episodeVideoTargetFileMegabytes: string;
  episodeVideoMinimumDurationSeconds: string;
  episodeUploadWaitTimeoutSeconds: string;
  episodeUploadFailedRetryAttempts: string;
}

export const defaultWechatMiniProgramRuntimeSettings: WechatMiniProgramRuntimeSettings = {
  apiBaseUrl: "http://180.184.76.232:19090",
  taskApiPrefix: "/dramaAiRpa/wechatMiniProgram",
  mockAssetRoot: "",
  localEpisodeVideoRoot: "",
  closeFailedTaskPages: "false",
  runDataDir: ".drama-runs/wechat-miniprogram-drama",
  logRetentionDays: "3",
  workerEmptyClaimDelaySeconds: "5",
  workerSlowEmptyClaimThreshold: "30",
  workerSlowEmptyClaimDelaySeconds: "30",
  videoAccountSyncIntervalSeconds: "600",
  idlePageRefreshIntervalSeconds: "10800",
  idlePageRefreshTimeoutSeconds: "60",
  idlePageRefreshJitterSeconds: "300",
  basicInfoStepTimeoutSeconds: "600",
  remoteFileDownloadTimeoutSeconds: "120",
  baiduNetdiskDownloadRetryAttempts: "3",
  mergeOwnershipMaterials: "true",
  materialPreparationConcurrency: "3",
  taskPrefetchPerAccount: "2",
  videoTranscodeConcurrency: "2",
  videoTranscodeThreadsPerJob: "2",
  episodeVideoMaxFileMegabytes: "490",
  episodeVideoTargetFileMegabytes: "480",
  episodeVideoMinimumDurationSeconds: "0",
  episodeUploadWaitTimeoutSeconds: "7200",
  episodeUploadFailedRetryAttempts: "5",
};

let runtimeSettings = defaultWechatMiniProgramRuntimeSettings;

export function configureWechatMiniProgramRuntimeSettings(settings: Partial<WechatMiniProgramRuntimeSettings> = {}): WechatMiniProgramRuntimeSettings {
  runtimeSettings = {
    ...defaultWechatMiniProgramRuntimeSettings,
    ...settings,
  };
  return runtimeSettings;
}

export function getWechatMiniProgramRuntimeSettings(): WechatMiniProgramRuntimeSettings {
  return runtimeSettings;
}
