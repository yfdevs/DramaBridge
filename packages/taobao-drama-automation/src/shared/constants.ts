export const TAOBAO_DRAMA_PLATFORM = "taobao-drama";

export const TAOBAO_DRAMA_COLLECTION_CREATE_URL =
  "https://creator.guanghe.taobao.com/page/unify/collect-create" +
  "?type=1&collectConfig=%5B1%2C3%5D&mode=0&source=guanghe" +
  "&from=%2Fpage%2Funify%2Fcollection";

export const TAOBAO_DRAMA_BATCH_PUBLISH_URL =
  "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish" +
  "?ugc_scene=short_drama_multipublish";

export const TAOBAO_DRAMA_LOGIN_URL =
  "https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&sub=true" +
  `&redirectURL=${encodeURIComponent(TAOBAO_DRAMA_BATCH_PUBLISH_URL)}`;

export const TAOBAO_DRAMA_FIXED_FIELDS = {
  collectionType: "短剧合集",
  paymentMode: "免费",
  completionStatus: "已完结",
  filingType: "备案号申请",
  producerName: "杨爱平",
  productionCompany: "明星说",
  directorName: "明星说",
  averageEpisodeDurationMinutes: 1,
} as const;

export const TAOBAO_DRAMA_MIN_SETTLE_MS = 10_000;
export const TAOBAO_DRAMA_PAGE_READY_RELOAD_MS = 30_000;
export const TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH = 100;
export const TAOBAO_DRAMA_EPISODE_UPLOAD_RETRY_ATTEMPTS = 5;
export const TAOBAO_DRAMA_MIN_VIDEO_DIMENSION = 1_088;
export const TAOBAO_DRAMA_MAX_EPISODES_PER_TASK = 1_000;
export const TAOBAO_DRAMA_COVER_WIDTH = 1_080;
export const TAOBAO_DRAMA_COVER_HEIGHT = 1_800;

export function taobaoEpisodeBatchRanges(
  episodeCount: number,
  batchSize = TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH,
) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 1; start <= episodeCount; start += batchSize) {
    ranges.push({ start, end: Math.min(episodeCount, start + batchSize - 1) });
  }
  return ranges;
}

export function taobaoEpisodeBatchPagePlan(
  episodeCount: number,
  batchSize = TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH,
) {
  return taobaoEpisodeBatchRanges(episodeCount, batchSize).map((range, index) => ({
    ...range,
    openNewPage: index > 0,
    closePreviousPageAfterSelection: index > 0,
  }));
}
