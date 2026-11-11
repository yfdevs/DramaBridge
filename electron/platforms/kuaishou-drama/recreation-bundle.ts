import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { ensureRenamedPortraitPoster, listLocalEpisodeFiles, listLocalPosterImages } from "@dramabridge/media-assets";
import { createConfiguredAiClient, getConfiguredAiImageModel, getConfiguredAiCoverGenerationRetryAttempts } from "../../global-app-config";
import { ensureBaiduNetdiskShareDownloaded, kuaishouRecreationMaterialRoot, uploadKuaishouRecreationVersion } from "../baidu-netdisk";
import type { FeishuTaskTransfer } from "../../integrations/feishu/task-runner";
import { validateRecreationInput } from "../../integrations/feishu/task-validation";

/** One video set and all title covers are verified and shared together. */
export const transferKuaishouRecreationBundle: FeishuTaskTransfer = async (input) => {
  const versions = input.versions ?? [];
  validateRecreationInput({ originalTitle: input.title, episodeCount: input.episodeCount, shareText: input.shareText, versions });
  const count = Math.ceil(input.episodeCount * 0.6);
  const key = createHash("sha256").update(JSON.stringify([input.title, input.shareText, input.episodeCount, versions])).digest("hex").slice(0, 16);
  const work = path.join(kuaishouRecreationMaterialRoot(), input.title, key);
  const output = path.join(work, "分享目录");
  const progress = (stage: string, completed = 0) => input.onProgress({ stage, completed, total: count });
  progress("下载前 60% 视频和原版封面");
  const downloaded = await ensureBaiduNetdiskShareDownloaded({
    requesterPlatform: "kuaishou-drama-recreation",
    shareText: input.shareText, resourceName: input.title,
    localEpisodeVideoRoot: path.join(work, "素材"),
    episodeCount: input.episodeCount, episodeDownloadLimit: count,
    downloadEpisodeVideos: true, downloadAssetMaterials: true,
    requireAllDiscoveredAssets: false,
    requiredPosterImages: 1, requiredOwnershipFiles: 0,
    requiredOwnership: { minimumImages: 0 },
  });
  const source = downloaded.localPath;
  if (!source) throw new Error("下载未返回本地素材目录");
  const episodes = (await listLocalEpisodeFiles({ root: source, resourceName: input.title, allowArbitraryDir: true }))
    .filter(file => file.index >= 1 && file.index <= count).sort((a, b) => a.index - b.index);
  if (episodes.length !== count || episodes.some((file, index) => file.index !== index + 1 || file.size <= 0))
    throw new Error(`前 ${count} 集视频不完整或集号重复`);
  if (episodes.some(file => path.extname(file.file).toLowerCase() !== ".mp4"))
    throw new Error("成片需要 MP4 视频，不能通过改扩展名转换格式");
  const posters = await listLocalPosterImages({ root: source, resourceName: input.title, rootIsResourceDir: true });
  if (!posters[0]) throw new Error("缺少原版封面，无法生成新标题封面");
  await mkdir(path.join(output, "成片"), { recursive: true });
  await mkdir(path.join(output, "封面"), { recursive: true });
  for (const episode of episodes) {
    const target = path.join(output, "成片", `${episode.index}.mp4`);
    await copyFile(episode.file, target, constants.COPYFILE_FICLONE);
    if ((await stat(target)).size !== episode.size) throw new Error(`成片复制不完整：${episode.index}.mp4`);
    progress("整理成片", episode.index);
  }
  await copyFile(posters[0].file, path.join(output, "封面", `${input.title}${path.extname(posters[0].file).toLowerCase()}`));
  for (const title of versions) {
    progress(`AI 替换封面标题：${title}`, count);
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
  progress("上传成片和全部封面，生成一个分享链接", count);
  const result = await uploadKuaishouRecreationVersion({
    localDirectory: output, remoteDirectory: `/快手_二创集合/${input.title}`,
    onProgress: message => progress(message, count),
  });
  return { path: result.remotePath, shareUrl: result.shareUrl };
};
