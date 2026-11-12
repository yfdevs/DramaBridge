import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { ensureRenamedPortraitPoster, listLocalPosterImages } from "@dramabridge/media-assets";
import type { FeishuTaskTransfer } from "../../integrations/feishu/task-runner";
import { validateRecreationInput } from "../../integrations/feishu/task-validation";

/** One video set and all title covers are verified and shared together. */
type Dependencies = Pick<typeof import("../baidu-netdisk"),
  "ensureBaiduNetdiskShareDownloaded" | "kuaishouRecreationMaterialRoot" | "uploadKuaishouRecreationVersion" | "transferKuaishouRecreationVideos">
  & Pick<typeof import("../../global-app-config"),
  "createConfiguredAiClient" | "getConfiguredAiImageModel" | "getConfiguredAiCoverGenerationRetryAttempts">;

export function createRecreationBundleTransfer(deps: Dependencies): FeishuTaskTransfer {
  const { ensureBaiduNetdiskShareDownloaded, kuaishouRecreationMaterialRoot, uploadKuaishouRecreationVersion,
    transferKuaishouRecreationVideos, createConfiguredAiClient, getConfiguredAiImageModel,
    getConfiguredAiCoverGenerationRetryAttempts } = deps;
  return async (input) => {
    const versions = input.versions ?? [];
    validateRecreationInput({ originalTitle: input.title, episodeCount: input.episodeCount, shareText: input.shareText, versions });
    const count = Math.ceil(input.episodeCount * 0.6);
    const key = createHash("sha256").update(JSON.stringify([input.title, input.shareText, input.episodeCount, versions])).digest("hex").slice(0, 16);
    const work = path.join(kuaishouRecreationMaterialRoot(), input.title, key);
    const output = path.join(work, "封面上传");
    const progress = (stage: string, completed = 0) => input.onProgress({ stage, completed, total: count });
    progress("准备原版封面（视频将云端转存）");
    const downloaded = await ensureBaiduNetdiskShareDownloaded({
      requesterPlatform: "kuaishou-drama-recreation",
      shareText: input.shareText, resourceName: input.title,
      localEpisodeVideoRoot: path.join(work, "素材"),
      episodeCount: input.episodeCount,
      downloadEpisodeVideos: false, downloadAssetMaterials: true,
      requireAllDiscoveredAssets: false,
      requiredPosterImages: 1, requiredOwnershipFiles: 0,
      requiredOwnership: { minimumImages: 0 },
    });
    const source = downloaded.localPath;
    if (!source) throw new Error("下载未返回本地素材目录");
    const posters = await listLocalPosterImages({ root: source, resourceName: input.title, rootIsResourceDir: true });
    if (!posters[0]) throw new Error("缺少原版封面，无法生成新标题封面");
    await mkdir(path.join(output, "封面"), { recursive: true });
    await copyFile(posters[0].file, path.join(output, "封面", `${input.title}${path.extname(posters[0].file).toLowerCase()}`));
    let videoCompleted = 0;
    let videoStage = "转存中";
    let coverStage = "生成中";
    const parallelProgress = () => input.onProgress({
      stage: `视频：${videoStage} · 封面：${coverStage}`, completed: videoCompleted, total: count,
    });
    // AI does not use the Baidu client. Keep its requests running while the
    // exclusive CDP operation transfers videos; cover upload joins the CDP queue.
    const videoPreparation = transferKuaishouRecreationVideos({
      title: input.title, versionTitle: `素材集合-${key}`, shareText: input.shareText,
      episodeCount: input.episodeCount, prepareBundle: true,
      onProgress: value => {
        videoCompleted = value.completed;
        videoStage = value.completed === count ? "已转存" : value.stage;
        parallelProgress();
      },
    });
    const coverPreparation = (async () => {
      for (const title of versions) {
        coverStage = `AI 改名「${title}」`;
        parallelProgress();
        const poster = await ensureRenamedPortraitPoster({
          client: createConfiguredAiClient(), model: getConfiguredAiImageModel(),
          referenceFile: posters[0].file, originalTitle: input.title, title,
          cacheDirectory: path.join(work, ".封面缓存"),
          retryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
        });
        const target = path.join(output, "封面", `${title}.png`);
        await writeFile(target + ".tmp", poster.data);
        await rename(target + ".tmp", target);
      }
      coverStage = "上传中";
      parallelProgress();
      const covers = await uploadKuaishouRecreationVersion({
        localDirectory: output, remoteDirectory: `/快手_二创集合/${input.title}/封面缓存-${key}-60%`,
        createShare: false,
        onProgress: () => parallelProgress(),
      });
      coverStage = "已就绪";
      parallelProgress();
      return covers;
    })();
    // Drain both branches on failure so retries cannot overlap leftover work.
    const [videoResult, coverResult] = await Promise.allSettled([videoPreparation, coverPreparation]);
    if (videoResult.status === "rejected") throw videoResult.reason;
    if (coverResult.status === "rejected") throw coverResult.reason;
    const covers = coverResult.value;
    progress("核验视频和封面，生成分享链接", count);
    const result = await transferKuaishouRecreationVideos({
      title: input.title, versionTitle: `素材集合-${key}`, shareText: input.shareText,
      episodeCount: input.episodeCount,
      bundleCovers: { directory: path.posix.join(covers.remotePath, "封面"), files: covers.verifiedEntries },
      onProgress: input.onProgress,
    });
    return { path: result.path, shareUrl: result.shareUrl };
  };
}
