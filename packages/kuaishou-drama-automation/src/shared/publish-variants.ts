import type {
  KuaishouDramaPublishVariant,
  KuaishouDramaTaskConfig,
} from "./types.js";

function withoutBookTitleMarks(title: string) {
  return title.trim().replace(/^《+/, "").replace(/》+$/, "").trim();
}

export function createKuaishouDramaPublishVariants(
  task: KuaishouDramaTaskConfig,
): KuaishouDramaPublishVariant[] {
  const lastEpisode = task.episodeCount;
  const fullPaidFreeEnd = Math.min(7, lastEpisode);
  const fullPaidRanges: KuaishouDramaPublishVariant["episodePriceRanges"] = [
    { startEpisode: 1, endEpisode: fullPaidFreeEnd, price: "免费" },
  ];
  if (lastEpisode >= 8) {
    fullPaidRanges.push({ startEpisode: 8, endEpisode: lastEpisode, price: "付费" });
  }

  const adUnlockRanges: KuaishouDramaPublishVariant["episodePriceRanges"] = [
    { startEpisode: 1, endEpisode: 1, price: "免费" },
  ];
  if (lastEpisode >= 2) {
    adUnlockRanges.push({ startEpisode: 2, endEpisode: lastEpisode, price: "付费" });
  }

  const variants: KuaishouDramaPublishVariant[] = [
    {
      kind: "full-paid",
      title: `《${withoutBookTitleMarks(task.title)}》`,
      saleMode: "全剧付费",
      fullDramaPriceYuan: task.fullDramaPriceYuan,
      episodePriceRanges: fullPaidRanges,
    },
    {
      kind: "ad-unlock",
      title: withoutBookTitleMarks(task.title),
      saleMode: "观看广告解锁",
      episodePriceRanges: adUnlockRanges,
    },
  ];

  if (task.publishType === "付费") return [variants[0]!];
  if (task.publishType === "广告") return [variants[1]!];
  const extraAdDefinitions = [
    ["ad-unlock-2", task.adVersion2Title],
    ["ad-unlock-3", task.adVersion3Title],
    ["ad-unlock-4", task.adVersion4Title],
    ["ad-unlock-5", task.adVersion5Title],
    ["ad-unlock-6", task.adVersion6Title],
    ["ad-unlock-7", task.adVersion7Title],
    ["ad-unlock-8", task.adVersion8Title],
  ] as const;
  const extraAds: KuaishouDramaPublishVariant[] = extraAdDefinitions.flatMap(
    ([kind, title]) =>
      title
        ? [
            {
              kind,
              title: withoutBookTitleMarks(title),
              saleMode: "观看广告解锁" as const,
              episodePriceRanges: adUnlockRanges,
            },
          ]
        : [],
  );
  if (task.publishType === "三个广告版本") {
    return [variants[1]!, ...extraAds.slice(0, 2)];
  }
  if (task.publishType === "五个广告版本") {
    return [variants[1]!, ...extraAds.slice(0, 4)];
  }
  if (task.publishType === "六个广告版本") {
    return [variants[1]!, ...extraAds.slice(0, 5)];
  }
  return task.publishType === "八个广告版本"
    ? [variants[1]!, ...extraAds]
    : [...variants, ...extraAds];
}
