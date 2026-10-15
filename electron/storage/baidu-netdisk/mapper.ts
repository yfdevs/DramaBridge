import type {
  BaiduNetdiskDownloadRecord,
  BaiduNetdiskDownloadRecordRow,
} from "./types";

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function readBaiduNetdiskDownloadRecord(
  row: BaiduNetdiskDownloadRecordRow,
): BaiduNetdiskDownloadRecord {
  return {
    completedAt: optional(row.completedAt),
    createdAt: row.createdAt,
    downloadDir: row.downloadDir,
    episodeCount: optional(row.episodeCount),
    error: optional(row.error),
    id: row.id,
    localEpisodeVideoRoot: optional(row.localEpisodeVideoRoot),
    localPath: optional(row.localPath),
    nativeStatus: optional(row.nativeStatus),
    progressPercent: optional(row.progressPercent),
    remoteCleanupError: optional(row.remoteCleanupError),
    remoteCleanupPending: row.remoteCleanupPending === 1,
    remoteTransferFsId: optional(row.remoteTransferFsId),
    remoteTransferOwned: row.remoteTransferOwned === 1,
    remoteTransferPath: optional(row.remoteTransferPath),
    remoteResourcePath: optional(row.remoteResourcePath),
    remoteResourceFsId: optional(row.remoteResourceFsId),
    remoteResourceCleanupCompletedAt: optional(row.remoteResourceCleanupCompletedAt),
    remoteResourceCleanupError: optional(row.remoteResourceCleanupError),
    resourceName: row.resourceName,
    shareKey: row.shareKey,
    shareText: row.shareText,
    skippedExisting: row.skippedExisting === 1,
    speedText: optional(row.speedText),
    startedAt: optional(row.startedAt),
    state: row.state,
    totalBytes: optional(row.totalBytes),
    transferredBytes: optional(row.transferredBytes),
    updatedAt: row.updatedAt,
  };
}

export function writeBaiduNetdiskDownloadRecordParams(record: BaiduNetdiskDownloadRecord) {
  return {
    ...record,
    completedAt: record.completedAt ?? null,
    episodeCount: record.episodeCount ?? null,
    error: record.error ?? null,
    localEpisodeVideoRoot: record.localEpisodeVideoRoot ?? null,
    localPath: record.localPath ?? null,
    nativeStatus: record.nativeStatus ?? null,
    progressPercent: record.progressPercent ?? null,
    remoteCleanupError: record.remoteCleanupError ?? null,
    remoteCleanupPending: record.remoteCleanupPending ? 1 : 0,
    remoteTransferFsId: record.remoteTransferFsId ?? null,
    remoteTransferOwned: record.remoteTransferOwned ? 1 : 0,
    remoteTransferPath: record.remoteTransferPath ?? null,
    remoteResourcePath: record.remoteResourcePath ?? null,
    remoteResourceFsId: record.remoteResourceFsId ?? null,
    remoteResourceCleanupCompletedAt: record.remoteResourceCleanupCompletedAt ?? null,
    remoteResourceCleanupError: record.remoteResourceCleanupError ?? null,
    skippedExisting: record.skippedExisting ? 1 : 0,
    speedText: record.speedText ?? null,
    startedAt: record.startedAt ?? null,
    totalBytes: record.totalBytes ?? null,
    transferredBytes: record.transferredBytes ?? null,
  };
}
