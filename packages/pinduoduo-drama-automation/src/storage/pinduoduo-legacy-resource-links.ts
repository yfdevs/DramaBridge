import {
  PINDUODUO_LEGACY_RESOURCE_LINKS,
  type PinduoduoLegacyResourceSeedEntry,
} from "../shared/pinduoduo-legacy-resource-links.generated.js";

export type PinduoduoResourceSource = "LEGACY_XLSX_ORIGINAL" | "PINDUODUO_LIST";

export type PinduoduoLegacyResourceLink = PinduoduoLegacyResourceSeedEntry;

export type PinduoduoResolvedResource = {
  shareText: string;
  source: PinduoduoResourceSource;
  sourceRows?: number[];
};

const TRAILING_PUNCTUATION = /[。！？!?，,；;：:]+$/gu;
// Pinduoduo timestamps are epoch milliseconds. The business cutoff is the
// beginning of 2026-09-25 in China Standard Time (UTC+8).
export const PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE = Date.UTC(
  2026,
  8,
  24,
  16,
);

export function normalizePinduoduoResourceTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/gu, "").replace(TRAILING_PUNCTUATION, "");
}

export function resolvePinduoduoResource(
  title: string,
  platformShareText: string | undefined,
  gmtCreate: number | undefined,
  legacyLink: PinduoduoLegacyResourceLink | undefined,
): PinduoduoResolvedResource {
  if (!Number.isFinite(gmtCreate)) {
    throw new Error(`PINDUODUO_GMT_CREATE_MISSING: “${title}”缺少有效的 gmt_create，无法选择百度网盘链接来源`);
  }

  if (gmtCreate! >= PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE) {
    if (!platformShareText?.trim()) {
      throw new Error(`PINDUODUO_RESOURCE_LINK_MISSING: “${title}”没有可用的百度网盘链接`);
    }
    return { shareText: platformShareText, source: "PINDUODUO_LIST" };
  }

  if (!legacyLink) {
    throw new Error(`PINDUODUO_LEGACY_RESOURCE_NOT_FOUND: 历史表中未找到“${title}”的百度网盘链接`);
  }
  if (!legacyLink.available || !legacyLink.originalShareText || !legacyLink.baiduUrl) {
    throw new Error(
      `PINDUODUO_LEGACY_RESOURCE_LINK_MISSING: 历史表已匹配“${title}”，但“网盘（原链接）”为空或无效（Excel 行 ${legacyLink.sourceRows.join(", ")}）`,
    );
  }
  return {
    shareText: legacyLink.originalShareText,
    source: "LEGACY_XLSX_ORIGINAL",
    sourceRows: legacyLink.sourceRows,
  };
}

const legacyLinks = new Map(PINDUODUO_LEGACY_RESOURCE_LINKS.map(entry => [entry.normalizedTitle, entry]));

export class PinduoduoLegacyResourceLinksRepository {
  close(): void {}
  findByTitle(title: string): PinduoduoLegacyResourceLink | undefined {
    return legacyLinks.get(normalizePinduoduoResourceTitle(title));
  }
}
