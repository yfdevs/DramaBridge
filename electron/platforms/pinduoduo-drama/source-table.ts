import type { FeishuTables, TableSnapshot } from "@dramabridge/feishu";

export const PINDUODUO_SOURCE_SHEET_TITLE = "拼多多-新剧";
export const PINDUODUO_FULL_SOURCE_URL = "https://a1arly9ixl.feishu.cn/wiki/VAyKwYNwUiMw9kkuU1lcBq3Qndc?sheet=QeuDEm";
export function validatePinduoduoSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".feishu.cn") ||
    !/^\/(wiki|sheets)\/[A-Za-z0-9]+\/?$/.test(url.pathname) ||
    (url.searchParams.has("sheet") && !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get("sheet")!))) {
    throw new Error("请填写飞书“拼多多-新剧”的知识库或电子表格链接");
  }
  return url;
}

type SourceRow = { number: number; shareText: string; sourceUrl?: string };
export function indexPinduoduoSource(table: TableSnapshot, linkHeader = "网盘（原链接）"): Map<string, SourceRow[]> {
  const find = (name: string) => {
    const matches = table.headers.flatMap((value, i) => value.trim() === name ? [i] : []);
    if (matches.length !== 1) throw new Error(`“${table.sheet.title}”需要唯一的“${name}”列`);
    return matches[0]!;
  };
  const titleColumn = find("剧名"), linkColumn = find(linkHeader);
  const index = new Map<string, SourceRow[]>();
  for (const row of table.rows) {
    const title = row.values[titleColumn]?.trim();
    if (!title) continue;
    const entries = index.get(title) ?? [];
    entries.push({ number: row.number, shareText: row.values[linkColumn]?.trim() ?? "" });
    index.set(title, entries);
  }
  return index;
}

export function matchPinduoduoSource(index: Map<string, SourceRow[]>, title: string, linkHeader = "网盘（原链接）"): SourceRow {
  const matches = index.get(title.trim());
  if (!matches?.length) throw new Error(`来源表未找到剧名“${title}”（匹配列：${linkHeader}）`);
  if (matches.some(row => !row.shareText)) throw new Error(`来源表“${title}”的“${linkHeader}”为空（行 ${matches.map(row => row.number).join("、")}）`);
  if (new Set(matches.map(row => row.shareText)).size !== 1) throw new Error(`来源表“${title}”存在不同的“${linkHeader}”链接，请先处理同名记录`);
  const row = matches[0]!;
  if (!/https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/i.test(row.shareText)) throw new Error(`来源表“${title}”的“${linkHeader}”不是有效的百度网盘分享链接`);
  return row;
}

/** Deliberately accepts only read(): this source document is never a write target. */
export class PinduoduoSourceTable {
  private cache?: { at: number; index: Map<string, SourceRow[]> };
  private loading?: Promise<Map<string, SourceRow[]>>;
  private primary?: PinduoduoSourceTable;
  constructor(private tables: Pick<FeishuTables, "read">, readonly url: string,
    private linkHeader = "网盘（原链接）", private sheetId?: string) {
    validatePinduoduoSourceUrl(url);
  }
  async read() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.index;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const table = await this.tables.read(this.url, PINDUODUO_SOURCE_SHEET_TITLE, { columns: ["剧名", this.linkHeader], ...(this.sheetId ? { sheetId: this.sheetId } : {}) });
      const expectedId = new URL(this.url).searchParams.get("sheet");
      if (expectedId && table.sheet.sheet_id !== expectedId) throw new Error("来源表链接中的 sheet 与“拼多多-新剧”不一致，请检查拼多多配置");
      const index = indexPinduoduoSource(table, this.linkHeader);
      this.cache = { at: Date.now(), index };
      return index;
    })();
    try { return await this.loading; }
    finally { this.loading = undefined; }
  }
  async resolve(title: string): Promise<SourceRow> {
    if (!this.sheetId) {
      this.primary ??= new PinduoduoSourceTable(this.tables, PINDUODUO_FULL_SOURCE_URL, "全集链接", "QeuDEm");
      const primaryIndex = await this.primary.read();
      if (primaryIndex.has(title.trim())) {
        return { ...matchPinduoduoSource(primaryIndex, title, "全集链接"), sourceUrl: PINDUODUO_FULL_SOURCE_URL };
      }
    }
    const index = await this.read();
    return { ...matchPinduoduoSource(index, title, this.linkHeader), sourceUrl: this.url };
  }
}
