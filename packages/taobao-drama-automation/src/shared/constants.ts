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
  productionCost: "30万以下",
  producerName: "杨爱平",
  productionCompany: "明星说",
  directorName: "明星说",
  scriptwriterName: "明星说",
  mainActors: "无",
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

export const TAOBAO_DRAMA_COLLECTION_PROPERTY_TAGS = [
  "校园", "民国", "职场", "都市", "年代", "古代", "宫廷", "乡村", "架空", "荒岛", "末日",
  "科幻", "恐怖", "玄幻修仙", "抗战", "现代言情", "武侠", "商战", "奇幻", "古代言情", "刑侦",
  "都市修仙", "权谋", "悬疑推理", "魔幻惊悚", "正能量", "玄学", "虐渣打脸", "豪门", "传承觉醒",
  "团宠", "娱乐圈", "逆袭", "异能", "宅斗", "鉴宝", "女性成长", "扮猪吃虎", "重生", "闪婚",
  "穿越", "先婚后爱", "破镜重圆", "青梅竹马", "真假千金", "虐恋", "宫斗", "穿书", "甜宠",
  "家庭伦理", "系统", "求生", "复仇", "马甲", "追妻火葬场", "暗恋", "替身", "古穿今",
  "带球跑", "创业", "契约婚姻", "身份反转", "年下", "替嫁", "相爱相杀", "失忆", "医术",
  "兵王", "小人物", "中老年", "大女主", "赘婿", "王妃", "嫡女", "反派", "萌宝", "女帝",
  "神豪", "弃少", "高手下山", "强者归来", "战神", "霸总", "黑道", "神医", "娇妻",
] as const;

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
