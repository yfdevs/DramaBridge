import type { FeishuTables, TableSnapshot } from "@dramabridge/feishu";

export const PINDUODUO_SOURCE_SHEET_TITLE = "拼多多-新剧";
export function validatePinduoduoSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".feishu.cn") ||
    !/^\/(wiki|sheets)\/[A-Za-z0-9]+\/?$/.test(url.pathname) ||
    (url.searchParams.has("sheet") && !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get("sheet")!))) {
    throw new Error("请填写飞书“拼多多-新剧”的知识库或电子表格链接");
  }
  return url;
}

type SourceRow = { number: number; shareText: string };
export function indexPinduoduoSource(table: TableSnapshot): Map<string, SourceRow[]> {
  const find = (name: string) => {
    const matches = table.headers.flatMap((value, i) => value.trim() === name ? [i] : []);
    if (matches.length !== 1) throw new Error(`“拼多多-新剧”需要唯一的“${name}”列`);
    return matches[0]!;
  };
  const titleColumn = find("剧名"), linkColumn = find("网盘（拼多多）");
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

export function matchPinduoduoSource(index: Map<string, SourceRow[]>, title: string): SourceRow {
  const matches = index.get(title.trim());
  if (!matches?.length) throw new Error(`来源表“拼多多-新剧”未找到剧名“${title}”`);
  if (matches.some(row => !row.shareText)) throw new Error(`来源表“${title}”的“网盘（拼多多）”为空（行 ${matches.map(row => row.number).join("、")}）`);
  if (new Set(matches.map(row => row.shareText)).size !== 1) throw new Error(`来源表“${title}”存在不同的“网盘（拼多多）”链接，请先处理同名记录`);
  const row = matches[0]!;
  if (!/https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/i.test(row.shareText)) throw new Error(`来源表“${title}”的“网盘（拼多多）”不是有效的百度网盘分享链接`);
  return row;
}

/** Deliberately accepts only read(): this source document is never a write target. */
export class PinduoduoSourceTable {
  private cache?: { at: number; index: Map<string, SourceRow[]> };
  private loading?: Promise<Map<string, SourceRow[]>>;
  constructor(private tables: Pick<FeishuTables, "read">, readonly url: string) {
    validatePinduoduoSourceUrl(url);
  }
  async read() {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.index;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const table = await this.tables.read(this.url, PINDUODUO_SOURCE_SHEET_TITLE);
      const expectedId = new URL(this.url).searchParams.get("sheet");
      if (expectedId && table.sheet.sheet_id !== expectedId) throw new Error("来源表链接中的 sheet 与“拼多多-新剧”不一致，请检查拼多多配置");
      const index = indexPinduoduoSource(table);
      this.cache = { at: Date.now(), index };
      return index;
    })();
    try { return await this.loading; }
    finally { this.loading = undefined; }
  }
  async resolve(title: string) { return matchPinduoduoSource(await this.read(), title); }
}
