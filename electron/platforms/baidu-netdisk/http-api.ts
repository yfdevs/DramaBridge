import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { openAutomationDatabase } from "../../storage/database";
import { BaiduNetdiskExternalTasksRepository } from "../../storage/baidu-netdisk/external-tasks-repository";
import { resolveGlobalPlatformDirectories } from "../../global-app-config";
import { ExternalDownloads } from "./external-downloads";
import {
  createExternalDownloadRoutes,
  postExternalDownloadCallback,
} from "./external-download-routes";
import {
  BAIDU_NETDISK_EXTERNAL_DIRECTORY,
  ensureBaiduNetdiskShareDownloaded,
  getBaiduNetdiskApiStatus,
  startBaiduNetdiskApiCdp,
  controlExternalBaiduNetdiskDownload,
  getExternalBaiduNetdiskDownloadRecord,
} from "./index";

/** Side effects are initialized lazily, so the default-off setting opens no database or socket. */
export function createBaiduNetdiskHttpApi() {
  let database: Database.Database | undefined;
  let downloads: ExternalDownloads | undefined;
  const manager = () => {
    if (downloads) return downloads;
    database = openAutomationDatabase().database;
    downloads = new ExternalDownloads(
      new BaiduNetdiskExternalTasksRepository(database),
      async (request, signal) => {
        signal.throwIfAborted();
        const root = resolveGlobalPlatformDirectories("external-api", {
          runDataDir: "",
          localMaterialRoot: "",
        }).localMaterialRoot;
        if (!root) throw new Error("请先在全局配置中设置素材目录");
        const record = await ensureBaiduNetdiskShareDownloaded({
          shareText: request.shareText,
          resourceName: request.resourceName,
          episodeCount: request.episodeCount,
          inferEpisodeCount: request.inferEpisodeCount,
          downloadEpisodeVideos: request.downloadEpisodeVideos,
          downloadAssetMaterials: request.downloadAssetMaterials,
          requiredPosterImages: request.requiredPosterImages,
          requesterPlatform: "external-api",
          localEpisodeVideoRoot: path.join(
            root,
            BAIDU_NETDISK_EXTERNAL_DIRECTORY,
            createHash("sha256").update(request.shareText).digest("hex").slice(0, 16),
          ),
          timeoutMs: request.timeoutSeconds * 1_000,
          signal,
        });
        if (record.state !== "completed") throw new Error(record.error || "下载未通过完成校验");
        return {
          downloadRecordId: record.id,
          localPath: record.localPath,
          episodeCount: record.episodeCount,
          skippedExisting: record.skippedExisting,
        };
      },
      postExternalDownloadCallback,
    );
    return downloads;
  };

  const handler = createExternalDownloadRoutes({
    manager,
    status: getBaiduNetdiskApiStatus,
    start: startBaiduNetdiskApiCdp,
    control: (task, action) => controlExternalBaiduNetdiskDownload(task.request, action),
    progress: (task) => {
      const record = getExternalBaiduNetdiskDownloadRecord(task.request);
      return record
        ? {
            percent: record.progressPercent,
            transferredBytes: record.transferredBytes,
            totalBytes: record.totalBytes,
            speedText: record.speedText,
            nativeStatus: record.nativeStatus,
          }
        : undefined;
    },
  });
  return {
    handler,
    initialize: () => {
      manager();
    },
    close: () => {
      downloads?.close();
      // Active workflows may still be unwinding; their finalizers use the database.
      // Electron closes the connection when the process exits.
    },
  };
}
