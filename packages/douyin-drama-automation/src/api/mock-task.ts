import {
  DOUYIN_DRAMA_AIGC_TOOL,
  DOUYIN_DRAMA_CONTRACT_NAMES,
} from "../shared/constants.js";
import { claimedDouyinDramaTaskSchema, type ClaimedDouyinDramaTask } from "../shared/types.js";

export const DOUYIN_DRAMA_MOCK_DOCUMENT_URL =
  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
export const DOUYIN_DRAMA_MOCK_IMAGE_URL = "https://www.w3.org/Icons/w3c_home.png";

export type CreateMockDouyinDramaTaskOptions = {
  accountId?: string;
  accountName?: string;
  accountTaskId?: number;
  audience?: "男频" | "女频" | "通用";
  baiduPanResourceLink?: string;
  category?: string;
  copyrightIpName?: string;
  costConfigurationFiles?: string[];
  episodeCount?: number;
  isAi?: boolean;
  isCopyrightIpAdaptation?: boolean;
  isSeries?: boolean;
  nonInfringementCommitmentFiles?: string[];
  ownershipProofFiles?: string[];
  payCommitmentFiles?: string[];
  publishAccountName?: string;
  projectScreenshotFiles?: string[];
  paidEpisodeStart?: number;
  roles?: Array<{
    name: string;
    actorName?: string;
    roleType?: "主角" | "配角" | "参演";
    photoFile?: string;
    intro?: string;
  }>;
  submit?: boolean;
  summary?: string;
  scheduledPublishAt?: string;
  title?: string;
  unitPriceYuan?: number;
};

function defaultMockScheduledPublishAt() {
  const value = new Date(Date.now() + 4 * 24 * 60 * 60 * 1_000);
  value.setMinutes(0, 0, 0);
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:00:00`
  );
}

function createMockTask(options: CreateMockDouyinDramaTaskOptions): ClaimedDouyinDramaTask {
  const title = options.title?.trim() || "赶海救下美人鱼，她让整片大海来报恩";
  const isAi = options.isAi ?? true;
  const isSeries = options.isSeries ?? false;
  const isCopyrightIpAdaptation = options.isCopyrightIpAdaptation ?? false;
  return claimedDouyinDramaTaskSchema.parse({
    accountTaskId: options.accountTaskId ?? 1,
    originalTitle: title,
    douyinAccountId: options.accountId?.trim() || "douyin-drama-test-account",
    douyinAccountName: options.accountName?.trim() || "抖音短剧测试账号",
    playlet: {
      title,
      summary:
        options.summary ??
        "小伙林海被亲叔谋害踹入大海，危难之际被鲛人少女宁汐救下。宁汐调动海中生灵报恩，助林海满载珍贵海货死里逃生",
      episodeCount: options.episodeCount ?? 10,
      baiduPanResourceLink:
        options.baiduPanResourceLink ??
        "链接: https://pan.baidu.com/s/1DqxBmsaWkLKKol5uHKxDNQ?pwd=hm6f 提取码: hm6f",
      isAi,
      aigcTools: isAi ? [DOUYIN_DRAMA_AIGC_TOOL] : [],
      categories: [options.category?.trim() || "都市脑洞"],
      audience: options.audience ?? "男频",
      isSeries,
      isCopyrightIpAdaptation,
      copyrightIpName: isCopyrightIpAdaptation ? options.copyrightIpName?.trim() : undefined,
      roles: options.roles ?? [
        {
          name: "林海",
          actorName: "明星说",
          roleType: "主角",
          photoFile: DOUYIN_DRAMA_MOCK_IMAGE_URL,
          intro: "被亲叔谋害后意外获救，凭借勇气与海洋伙伴重启人生的青年",
        },
        {
          name: "宁汐",
          actorName: "明星说",
          roleType: "主角",
          photoFile: DOUYIN_DRAMA_MOCK_IMAGE_URL,
          intro: "善良勇敢的鲛人少女，为报答林海而召集海中生灵帮助他渡过难关",
        },
      ],
      productionCostWan: 1,
      publishMode: "自主发布",
      publishAccountName: options.publishAccountName?.trim() || "兜兜动漫",
      scheduledPublishAt: options.scheduledPublishAt?.trim() || defaultMockScheduledPublishAt(),
      unitPriceYuan: options.unitPriceYuan ?? 0.5,
      paidEpisodeStart: options.paidEpisodeStart ?? 10,
      costConfigurationFiles: options.costConfigurationFiles ?? [DOUYIN_DRAMA_MOCK_IMAGE_URL],
      // This field is conditional and is not rendered for the current motion-comic
      // form/account. Keep it empty by default; callers can still provide files
      // when the platform exposes the corresponding upload control.
      payCommitmentFiles: options.payCommitmentFiles ?? [],
      ownershipProofFiles: options.ownershipProofFiles ?? [DOUYIN_DRAMA_MOCK_DOCUMENT_URL],
      nonInfringementCommitmentFiles: options.nonInfringementCommitmentFiles ?? [
        DOUYIN_DRAMA_MOCK_IMAGE_URL,
      ],
      // 工程文件截图必须来自当前任务的百度网盘“剪映”素材，不能用通用
      // mock 图片冒充。资源准备阶段会从下载目录中严格挑选 4 张。
      projectScreenshotFiles: options.projectScreenshotFiles ?? [],
      contractName: DOUYIN_DRAMA_CONTRACT_NAMES[1],
      submit: options.submit ?? false,
    },
  });
}

export function createMockDouyinDramaTask(options: CreateMockDouyinDramaTaskOptions = {}) {
  return createMockTask(options);
}

export function createMockDouyinSelfProducedAiTask(
  options: Omit<
    CreateMockDouyinDramaTaskOptions,
    "isAi" | "isCopyrightIpAdaptation" | "isSeries"
  > = {},
) {
  return createMockTask({
    ...options,
    accountTaskId: options.accountTaskId ?? 1_001,
    isAi: true,
    isCopyrightIpAdaptation: false,
    isSeries: false,
  });
}

export function createMockDouyinSelfProducedNonAiTask(
  options: Omit<
    CreateMockDouyinDramaTaskOptions,
    "isAi" | "isCopyrightIpAdaptation" | "isSeries"
  > = {},
) {
  return createMockTask({
    ...options,
    accountTaskId: options.accountTaskId ?? 1_002,
    isAi: false,
    isCopyrightIpAdaptation: false,
    isSeries: false,
  });
}

export function createMockDouyinCopyrightSeriesTask(
  options: Omit<CreateMockDouyinDramaTaskOptions, "isCopyrightIpAdaptation" | "isSeries"> & {
    copyrightIpName: string;
  },
) {
  return createMockTask({
    ...options,
    accountTaskId: options.accountTaskId ?? 1_003,
    isCopyrightIpAdaptation: true,
    isSeries: true,
  });
}

export function createMockDouyinNetdiskTestTask(
  options: Pick<
    CreateMockDouyinDramaTaskOptions,
    "accountId" | "accountName" | "paidEpisodeStart" | "submit" | "unitPriceYuan"
  > = {},
) {
  return createMockTask({
    ...options,
    accountTaskId: 90_001,
    title: "货车被当免费拉货站，我收车",
    // Deliberately empty: this mock exercises the real netdisk TXT + single AI
    // enrichment path without introducing a separate mock configuration switch.
    summary: "",
    episodeCount: 35,
    baiduPanResourceLink:
      "链接: https://pan.baidu.com/s/1GyEobepwLhJj5ND2swgvIQ?pwd=efd9 提取码: efd9",
    category: "都市日常",
    audience: "通用",
    isAi: true,
    isCopyrightIpAdaptation: true,
    copyrightIpName: "我都成反派们师父了，能是好人？",
    isSeries: false,
    roles: [],
  });
}
