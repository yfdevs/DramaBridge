import type { FeishuClient } from "../client.js";
import PQueue from "p-queue";

export function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("无效列号");
  let name = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
export function cellText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") {
    const cell = value as Record<string, unknown>;
    return cellText(cell.link ?? cell.url ?? cell.text ?? "");
  }
  return String(value).trim();
}
export type Sheet = {
  sheet_id: string;
  title: string;
  grid_properties: { row_count: number; column_count: number };
};
export type TableSnapshot = {
  spreadsheet: string;
  sheet: Sheet;
  headers: string[];
  rows: { number: number; values: string[] }[];
};

/** Wiki resolution and Sheets operations shared by every platform adapter. */
export class FeishuTables {
  private readQueue = new PQueue({ concurrency: 3, intervalCap: 5, interval: 1000 });
  constructor(private client: FeishuClient) {}
  async resolve(link: string): Promise<string> {
    const url = new URL(link);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".feishu.cn"))
      throw new Error("请填写飞书知识库或电子表格链接");
    const match = url.pathname.match(/^\/(wiki|sheets)\/([A-Za-z0-9]+)/);
    if (!match) throw new Error("仅支持飞书知识库中的电子表格或 sheets 链接");
    if (match[1] === "sheets") return match[2];
    const data = await this.client.request<{ node: { obj_type: string; obj_token: string } }>(
      `/wiki/v2/spaces/get_node?token=${match[2]}`,
    );
    if (!["sheet", "sheets"].includes(data.node.obj_type))
      throw new Error("目标知识库节点不是电子表格");
    return data.node.obj_token;
  }
  async read(link: string, title: string, options: { columns?: string[]; sheetId?: string } = {}): Promise<TableSnapshot> {
    const spreadsheet = await this.resolve(link);
    const { sheets } = await this.client.request<{ sheets: Sheet[] }>(
      `/sheets/v3/spreadsheets/${spreadsheet}/sheets/query`,
    );
    const matches = sheets.filter((sheet) => options.sheetId ? sheet.sheet_id === options.sheetId : sheet.title === title);
    if (matches.length !== 1) throw new Error(`未找到唯一工作表“${title}”`);
    const sheet = matches[0];
    if (sheet.grid_properties.column_count > 500 || sheet.grid_properties.row_count > 100_000)
      throw new Error("工作表过大，请使用不超过500列、10万行的任务表");
    const values: string[][] = Array.from({ length: sheet.grid_properties.row_count }, () => []);
    const last = columnName(sheet.grid_properties.column_count - 1);
    let readError: unknown;
    const readCall = <T>(url: string) => this.readQueue.add(async () => {
      if (readError) throw readError;
      try { return await this.client.request<T>(url); }
      catch (error) { readError = error; throw error; }
    });
    const readRange = (range: string) => readCall<{ valueRange: { values?: unknown[][] } }>(`/sheets/v2/spreadsheets/${spreadsheet}/values/${encodeURIComponent(range)}?valueRenderOption=ToString`);
    let spans = [{ first: 0, last: sheet.grid_properties.column_count - 1 }];
    let startRow = 1;
    if (options.columns) {
      const header = await readRange(`${sheet.sheet_id}!A1:${last}1`);
      values[0] = (header.valueRange.values?.[0] ?? []).map(cellText);
      const columns = options.columns.map(name => {
        const matches = values[0].flatMap((value, index) => value.trim() === name ? [index] : []);
        if (matches.length !== 1) throw new Error(`“${title}”需要唯一的“${name}”列`);
        return matches[0];
      }).sort((a, b) => a - b);
      spans = [];
      for (const column of new Set(columns)) {
        const previous = spans[spans.length - 1];
        if (previous && previous.last + 1 === column) previous.last = column;
        else spans.push({ first: column, last: column });
      }
      startRow = 2;
    }
    const ranges: { range: string; row: number; length: number; first: number; last: number }[] = [];
    for (let row = startRow; row <= sheet.grid_properties.row_count; row += 1000) {
      for (const span of spans) {
        const length = Math.min(1000, sheet.grid_properties.row_count - row + 1);
        const range = `${sheet.sheet_id}!${columnName(span.first)}${row}:${columnName(span.last)}${row + length - 1}`;
        ranges.push({ range, row, length, ...span });
      }
    }
    const assign = (range: typeof ranges[number], cellsByRow: unknown[][] = []) => {
      for (let offset = 0; offset < range.length; offset++) {
        const cells = cellsByRow[offset] ?? [];
        for (let column = range.first; column <= range.last && column - range.first < cells.length; column++)
          values[range.row + offset - 1][column] = cellText(cells[column - range.first]);
      }
    };
    const reads: Promise<unknown>[] = [];
    if (options.columns) {
      for (let start = 0; start < ranges.length; start += 10) {
        const batch = ranges.slice(start, start + 10);
        const query = new URLSearchParams({ ranges: batch.map(item => item.range).join(","), valueRenderOption: "ToString" });
        reads.push(readCall<{ valueRanges: { range: string; values?: unknown[][] }[] }>(`/sheets/v2/spreadsheets/${spreadsheet}/values_batch_get?${query}`).then(data => {
          for (const range of batch) {
            const matches = data.valueRanges?.filter(item => item.range === range.range) ?? [];
            if (matches.length !== 1) throw new Error("飞书来源列读取不完整，请重试");
            assign(range, matches[0].values);
          }
        }));
      }
    } else {
      for (const range of ranges) reads.push(readRange(range.range).then(data => assign(range, data.valueRange.values)));
    }
    await Promise.all(reads);
    const headers = values.shift() ?? [];
    return {
      spreadsheet,
      sheet,
      headers,
      rows: values.map((row, index) => ({ number: index + 2, values: row })),
    };
  }
  async list(link: string): Promise<Sheet[]> {
    const spreadsheet = await this.resolve(link);
    const data = await this.client.request<{ sheets: Sheet[] }>(
      `/sheets/v3/spreadsheets/${spreadsheet}/sheets/query`,
    );
    return data.sheets;
  }
  async writeCells(table: TableSnapshot, row: number, cells: { column: number; value: string }[]) {
    return this.writeRows(table, [{ row, cells }]);
  }
  async writeRows(table: TableSnapshot, rows: { row: number; cells: { column: number; value: string }[] }[]) {
    const valueRanges: { range: string; values: string[][] }[] = [];
    for (const { row, cells } of rows) {
      const ordered = [...cells].sort((a, b) => a.column - b.column);
      for (let i = 0; i < ordered.length;) {
        const first = ordered[i];
        const values = [first.value];
        let end = i;
        while (end + 1 < ordered.length && ordered[end + 1].column === ordered[end].column + 1) values.push(ordered[++end].value);
        valueRanges.push({ range: `${table.sheet.sheet_id}!${columnName(first.column)}${row}:${columnName(ordered[end].column)}${row}`, values: [values] });
        i = end + 1;
      }
    }
    // Keep batches small and serial; task writers retain their coordinator lock.
    for (let start = 0; start < valueRanges.length; start += 100) await this.client.request(
      `/sheets/v2/spreadsheets/${table.spreadsheet}/values_batch_update`,
      "POST",
      {
        valueRanges: valueRanges.slice(start, start + 100),
      },
    );
  }
  async ensureRows(table: TableSnapshot, count: number) {
    if (count <= table.sheet.grid_properties.row_count) return;
    await this.client.request(`/sheets/v2/spreadsheets/${table.spreadsheet}/dimension_range`, "POST", {
      dimension: { sheetId: table.sheet.sheet_id, majorDimension: "ROWS", length: count - table.sheet.grid_properties.row_count },
    });
    table.sheet.grid_properties.row_count = count;
  }
  async hideColumn(table: TableSnapshot, column: number) {
    await this.client.request(`/sheets/v2/spreadsheets/${table.spreadsheet}/dimension_range`, "PUT", {
      dimension: { sheetId: table.sheet.sheet_id, majorDimension: "COLUMNS", startIndex: column, endIndex: column + 1 },
      dimensionProperties: { visible: false },
    });
  }
  async markError(table: TableSnapshot, row: number, column: number, failed: boolean) {
    await this.client.request(
      `/sheets/v2/spreadsheets/${table.spreadsheet}/styles_batch_update`,
      "PUT",
      {
        data: [
          {
            ranges: [
              `${table.sheet.sheet_id}!${columnName(column)}${row}:${columnName(column)}${row}`,
            ],
            style: {
              backColor: failed ? "#FEE2E2" : "#FFFFFF",
              foreColor: failed ? "#991B1B" : "#171717",
            },
          },
        ],
      },
    );
  }
}
