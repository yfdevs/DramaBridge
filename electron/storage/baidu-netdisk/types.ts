export type BaiduNetdiskDownloadState = "pending" | "downloading" | "completed" | "failed";

export type BaiduNetdiskDownloadRecord = {
  id: string;
  shareKey: string;
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot?: string;
  episodeCount?: number;
  downloadDir: string;
  localPath?: string;
  progressPercent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedText?: string;
  nativeStatus?: string;
  state: BaiduNetdiskDownloadState;
  skippedExisting: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  remoteTransferPath?: string;
  remoteTransferFsId?: string;
  remoteTransferOwned?: boolean;
  remoteCleanupPending?: boolean;
  remoteCleanupError?: string;
  remoteResourcePath?: string;
  remoteResourceFsId?: string;
  remoteResourceCleanupCompletedAt?: string;
  remoteResourceCleanupError?: string;
};

export type BaiduNetdiskDownloadRecordRow = Omit<
  BaiduNetdiskDownloadRecord,
  | "localEpisodeVideoRoot"
  | "episodeCount"
  | "localPath"
  | "progressPercent"
  | "transferredBytes"
  | "totalBytes"
  | "speedText"
  | "nativeStatus"
  | "skippedExisting"
  | "error"
  | "startedAt"
  | "completedAt"
  | "remoteTransferPath"
  | "remoteTransferFsId"
  | "remoteTransferOwned"
  | "remoteCleanupPending"
  | "remoteCleanupError"
  | "remoteResourcePath"
  | "remoteResourceFsId"
  | "remoteResourceCleanupCompletedAt"
  | "remoteResourceCleanupError"
> & {
  completedAt: string | null;
  episodeCount: number | null;
  error: string | null;
  localEpisodeVideoRoot: string | null;
  localPath: string | null;
  nativeStatus: string | null;
  progressPercent: number | null;
  skippedExisting: 0 | 1;
  speedText: string | null;
  startedAt: string | null;
  totalBytes: number | null;
  transferredBytes: number | null;
  remoteTransferPath: string | null;
  remoteTransferFsId: string | null;
  remoteTransferOwned: 0 | 1;
  remoteCleanupPending: 0 | 1;
  remoteCleanupError: string | null;
  remoteResourcePath: string | null;
  remoteResourceFsId: string | null;
  remoteResourceCleanupCompletedAt: string | null;
  remoteResourceCleanupError: string | null;
};
