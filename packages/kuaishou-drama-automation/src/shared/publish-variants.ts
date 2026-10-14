import type {
  KuaishouDramaPublishVariant,
  KuaishouDramaTaskConfig,
} from "./types.js";
import {
  resolveKuaishouAdVersionCount,
  resolveKuaishouAdVersionTitles,
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

  const paidVariant: KuaishouDramaPublishVariant = {
      kind: "full-paid",
      title: `《${withoutBookTitleMarks(task.title)}》`,
      saleMode: "全剧付费",
      fullDramaPriceYuan: task.fullDramaPriceYuan,
      episodePriceRanges: fullPaidRanges,
  };
  const adVersionCount = resolveKuaishouAdVersionCount(task);
  const adVersionTitles = resolveKuaishouAdVersionTitles(task);
  const adVariants: KuaishouDramaPublishVariant[] = Array.from(
    { length: adVersionCount },
    (_, index) => ({
      kind: index === 0 ? "ad-unlock" : `ad-unlock-${index + 1}`,
      title: index === 0
        ? withoutBookTitleMarks(task.title)
        : withoutBookTitleMarks(adVersionTitles[index - 1]!),
      saleMode: "观看广告解锁",
      episodePriceRanges: adUnlockRanges,
    }),
  );

  if (task.publishType === "付费") return [paidVariant];
  if (task.publishType === "全部" || task.publishType === undefined) {
    return [paidVariant, ...adVariants];
  }
  return adVariants;
}
