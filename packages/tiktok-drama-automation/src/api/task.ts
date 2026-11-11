import { schemaObject, type Scheme } from "../scheme.js";

export type ClaimedTiktokDramaTask = {
  accountTaskId: number;
  allowMissingVideos?: boolean;
  dramaId?: number;
  originalTitle: string;
  scheme: Scheme;
};

export async function claimNextTiktokDramaTaskApi(): Promise<ClaimedTiktokDramaTask | null> {
  const fakeTask = {
    accountTaskId: 492,
    allowMissingVideos: false,
    dramaId: 10001,
    originalTitle: "黑石岛逆袭主二",
    scheme: {
      id: "tiktok-demo-492",
      title: "黑石岛逆袭主二",
      description: "这里填写剧集简介",
      episodeCount: 2,
      baiduPanResourceLink:
        "链接: https://pan.baidu.com/s/1uNpbHCXDOx3nQm-ge3rq1g?pwd=capu 提取码: capu <br/>--来自百度网盘超级会员v5的分享",
      coverFile:
        "https://misu-launch-lianshan-beijing-final.tos-cn-beijing.volces.com/drama-ai-rpa/posters/20260624/account-task-492-5da4e945eff84573acdda9ec87782835.jpg",
      targetAudience: "女性",
      themes: ["都市", "总裁"],
      sourceLanguage: "中文",
      isAiDrama: "是",
      publishMode: "过审后自动发布",
      autoMountAnchor: true,
      hostingMode: true,
      freePreviewEpisodes: 1,
      paidFreePreviewEpisodes: 1,
      pricePerEpisode: 0.31,
      actors: ["叶辰", "刘战斌"],
      contractText: "CT20260618700038",
      submit: false,
    },
  };

  return {
    ...fakeTask,
    scheme: schemaObject.parse(fakeTask.scheme),
  };
}
