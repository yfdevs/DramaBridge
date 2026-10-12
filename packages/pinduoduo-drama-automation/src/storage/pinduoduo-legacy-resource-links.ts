import type Database from "better-sqlite3";
import type { PinduoduoDramaRuntimeOptions } from "../shared/types.js";
import {
  PINDUODUO_LEGACY_RESOURCE_LINKS,
  PINDUODUO_LEGACY_RESOURCE_SEED_VERSION,
  type PinduoduoLegacyResourceSeedEntry,
} from "../shared/pinduoduo-legacy-resource-links.generated.js";
import { openAutomationDatabase } from "./database.js";

export type PinduoduoResourceSource = "LEGACY_XLSX_ORIGINAL" | "PINDUODUO_LIST";

export type PinduoduoLegacyResourceLink = PinduoduoLegacyResourceSeedEntry;

export type PinduoduoResolvedResource = {
  shareText: string;
  source: PinduoduoResourceSource;
  sourceRows?: number[];
};

type LegacyResourceRow = {
  normalizedTitle: string;
  title: string;
  originalShareText: string | null;
  baiduUrl: string | null;
  sourceDate: string | null;
  episodeCount: number | null;
  sourceRows: string;
  available: number;
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

function migrateLegacyResourceLinks(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pinduoduo_legacy_resource_links (
      normalized_title TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      original_share_text TEXT,
      baidu_url TEXT,
      source_date TEXT,
      episode_count INTEGER,
      source_rows TEXT NOT NULL,
      available INTEGER NOT NULL,
      seed_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinduoduo_legacy_resource_seed (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seed_version TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);
}

function seedLegacyResourceLinks(database: Database.Database): void {
  const current = database
    .prepare("SELECT seed_version AS seedVersion FROM pinduoduo_legacy_resource_seed WHERE id=1")
    .get() as { seedVersion: string } | undefined;
  if (current?.seedVersion === PINDUODUO_LEGACY_RESOURCE_SEED_VERSION) return;

  const insert = database.prepare(`
    INSERT INTO pinduoduo_legacy_resource_links (
      normalized_title, title, original_share_text, baidu_url, source_date,
      episode_count, source_rows, available, seed_version, created_at, updated_at
    ) VALUES (
      @normalizedTitle, @title, @originalShareText, @baiduUrl, @sourceDate,
      @episodeCount, @sourceRows, @available, @seedVersion, @createdAt, @updatedAt
    )
  `);
  database.transaction(() => {
    const timestamp = new Date().toISOString();
    database.prepare("DELETE FROM pinduoduo_legacy_resource_links").run();
    for (const entry of PINDUODUO_LEGACY_RESOURCE_LINKS) {
      insert.run({
        ...entry,
        available: entry.available ? 1 : 0,
        sourceRows: JSON.stringify(entry.sourceRows),
        seedVersion: PINDUODUO_LEGACY_RESOURCE_SEED_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    database.prepare(`
      INSERT INTO pinduoduo_legacy_resource_seed (id, seed_version, imported_at)
      VALUES (1, @seedVersion, @importedAt)
      ON CONFLICT(id) DO UPDATE SET
        seed_version=excluded.seed_version,
        imported_at=excluded.imported_at
    `).run({ seedVersion: PINDUODUO_LEGACY_RESOURCE_SEED_VERSION, importedAt: timestamp });
  })();
}

function readLegacyResourceLink(row: LegacyResourceRow): PinduoduoLegacyResourceLink {
  return {
    normalizedTitle: row.normalizedTitle,
    title: row.title,
    originalShareText: row.originalShareText,
    baiduUrl: row.baiduUrl,
    sourceDate: row.sourceDate,
    episodeCount: row.episodeCount,
    sourceRows: JSON.parse(row.sourceRows) as number[],
    available: row.available === 1,
  };
}

export class PinduoduoLegacyResourceLinksRepository {
  private readonly database: Database.Database;

  constructor(options: PinduoduoDramaRuntimeOptions) {
    this.database = openAutomationDatabase(options);
    migrateLegacyResourceLinks(this.database);
    seedLegacyResourceLinks(this.database);
  }

  close(): void {
    this.database.close();
  }

  findByTitle(title: string): PinduoduoLegacyResourceLink | undefined {
    const row = this.database.prepare(`
      SELECT
        normalized_title AS normalizedTitle,
        title,
        original_share_text AS originalShareText,
        baidu_url AS baiduUrl,
        source_date AS sourceDate,
        episode_count AS episodeCount,
        source_rows AS sourceRows,
        available
      FROM pinduoduo_legacy_resource_links
      WHERE normalized_title=@normalizedTitle
    `).get({ normalizedTitle: normalizePinduoduoResourceTitle(title) }) as LegacyResourceRow | undefined;
    return row ? readLegacyResourceLink(row) : undefined;
  }
}
