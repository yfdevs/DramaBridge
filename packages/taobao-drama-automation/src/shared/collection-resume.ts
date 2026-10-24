import type { TaobaoCollectionDetail } from "../api/collection-detail.js";
import { TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH } from "./constants.js";

export type TaobaoCollectionUploadPlan = {
  collectionId: string; title: string; episodeCount: number;
  uploadedEpisodeNumbers: number[]; missingEpisodeNumbers: number[];
  submittedEpisodeNumbers?: number[];
};

function invalid(reason: string): never {
  throw new Error(`TAOBAO_DRAMA_COLLECTION_RESUME_UNSAFE: ${reason}。已停止上传，请核实淘宝合集，避免重复上传或补错集。`);
}

export function applyTaobaoConfirmedSubmissions(plan: TaobaoCollectionUploadPlan, episodeNumbers: number[]) {
  const submitted = [...new Set([...(plan.submittedEpisodeNumbers ?? []), ...episodeNumbers])].sort((a, b) => a - b);
  if (submitted.some((episode) => !Number.isInteger(episode) || episode < 1 || episode > plan.episodeCount)) {
    invalid("本地已确认提交记录的集号与任务总集数不一致");
  }
  const accepted = new Set([...plan.uploadedEpisodeNumbers, ...submitted]);
  return { ...plan, submittedEpisodeNumbers: submitted,
    missingEpisodeNumbers: Array.from({ length: plan.episodeCount }, (_, index) => index + 1).filter((episode) => !accepted.has(episode)) };
}

export function createTaobaoCollectionUploadPlan(
  detail: TaobaoCollectionDetail, title: string, episodeCount: number,
): TaobaoCollectionUploadPlan {
  const info = detail.collectionInfo;
  if (info.title !== title.trim()) invalid(`合集名称不一致：期望“${title}”，实际“${info.title}”`);
  if (info.episodeCount !== episodeCount) invalid(`合集登记总集数为 ${info.episodeCount}，任务要求 ${episodeCount}`);
  const cards = detail.contentCards;
  const ids = new Set(info.contentIds);
  const cardIds = new Set(cards.map((card) => card.baseInfo.id));
  if (cards.length !== info.contentCount || ids.size !== info.contentCount ||
      cardIds.size !== info.contentCount || info.contentIds.length !== info.contentCount ||
      cards.some((card) => !ids.has(card.baseInfo.id) || card.baseInfo.collectionId !== info.collectionId)) {
    invalid(`详情列表不完整或重复：合集显示 ${info.contentCount} 条，实际返回 ${cards.length} 条`);
  }
  const uploadedEpisodeNumbers = cards.map((card) => {
    const match = /^第\s*(\d+)\s*集/.exec(card.baseInfo.title.normalize("NFKC"));
    if (!match) invalid(`视频“${card.baseInfo.title}”无法识别集号`);
    const episode = Number(match[1]);
    if (!Number.isSafeInteger(episode) || episode < 1 || episode > episodeCount) invalid(`视频“${card.baseInfo.title}”的集号不在 1～${episodeCount} 范围内`);
    return episode;
  }).sort((a, b) => a - b);
  const uploaded = new Set(uploadedEpisodeNumbers);
  if (uploaded.size !== uploadedEpisodeNumbers.length) invalid("同一集号对应多条视频");
  return { collectionId: info.collectionId, title: info.title, episodeCount, uploadedEpisodeNumbers,
    missingEpisodeNumbers: Array.from({ length: episodeCount }, (_, index) => index + 1).filter((episode) => !uploaded.has(episode)) };
}

// Batch positions are independent of episode numbers: holes such as 2, 5 and
// 101 retain their original episode metadata and collection episode selection.
export function planTaobaoEpisodeUploadBatches<T extends { index: number }>(
  episodes: T[], missingEpisodeNumbers = episodes.map((episode) => episode.index),
  batchSize = TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH) invalid("上传批次大小无效");
  const byNumber = new Map(episodes.map((episode) => [episode.index, episode]));
  const wanted = new Set(missingEpisodeNumbers);
  if (byNumber.size !== episodes.length || wanted.size !== missingEpisodeNumbers.length) invalid("本地视频或待补传集号重复");
  const selected = [...wanted].sort((a, b) => a - b).map((episode) => {
    const video = byNumber.get(episode);
    if (!video || !Number.isInteger(episode) || episode < 1) invalid(`未找到待补传的第 ${episode} 集本地文件`);
    return video;
  });
  const batches: T[][] = [];
  for (let position = 0; position < selected.length; position += batchSize) batches.push(selected.slice(position, position + batchSize));
  return batches;
}
