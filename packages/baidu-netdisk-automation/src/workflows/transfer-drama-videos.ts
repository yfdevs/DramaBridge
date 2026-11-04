import { randomBytes } from "node:crypto";
import { openBaiduNetdiskSharePage, saveShareToOwnNetdisk } from './download-baidu-folder.js';
import { parseBaiduNetdiskShareText } from '../domain/share-text.js';

export async function transferBaiduDramaVideos(options: {
  shareText: string; title: string; episodeCount: number; port: number;
  onProgress?: (progress: { completed: number; total: number; stage: string }) => void;
}) {
  if (!options.title.trim() || !Number.isInteger(options.episodeCount) || options.episodeCount < 1) {
    throw new Error('剧名或集数无效');
  }
  const share = { ...parseBaiduNetdiskShareText(options.shareText), name: options.title.trim() };
  options.onProgress?.({ completed: 0, total: options.episodeCount, stage: '读取分享' });
  const target = await openBaiduNetdiskSharePage(share, options.port);
  const result = await saveShareToOwnNetdisk(target, share, { normalizedVideoEpisodeCount: options.episodeCount, videoSharePassword: randomBytes(2).toString("hex"), onVideoProgress: options.onProgress });
  if (!result.shareUrl) throw new Error('视频已转存但未生成分享链接，请重试');
  return { shareUrl: result.shareUrl, path: result.resourceRootPath, count: result.remoteVideos.files.length };
}
