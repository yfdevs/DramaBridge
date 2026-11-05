import type { FeishuClient } from "../client.js";

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
  async read(link: string, title: string): Promise<TableSnapshot> {
    const spreadsheet = await this.resolve(link);
    const { sheets } = await this.client.request<{ sheets: Sheet[] }>(
      `/sheets/v3/spreadsheets/${spreadsheet}/sheets/query`,
    );
    const matches = sheets.filter((sheet) => sheet.title === title);
    if (matches.length !== 1) throw new Error(`未找到唯一工作表“${title}”`);
    const sheet = matches[0];
    if (sheet.grid_properties.column_count > 500 || sheet.grid_properties.row_count > 100_000)
      throw new Error("工作表过大，请使用不超过500列、10万行的任务表");
    const values: string[][] = [];
    const last = columnName(sheet.grid_properties.column_count - 1);
    for (let row = 1; row <= sheet.grid_properties.row_count; row += 1000) {
      const range = `${sheet.sheet_id}!A${row}:${last}${Math.min(row + 999, sheet.grid_properties.row_count)}`;
      const data = await this.client.request<{ valueRange: { values?: unknown[][] } }>(
        `/sheets/v2/spreadsheets/${spreadsheet}/values/${encodeURIComponent(range)}?valueRenderOption=ToString`,
      );
      for (
        let offset = 0;
        offset < Math.min(1000, sheet.grid_properties.row_count - row + 1);
        offset++
      )
        values.push((data.valueRange.values?.[offset] ?? []).map(cellText));
    }
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
    await this.client.request(
      `/sheets/v2/spreadsheets/${table.spreadsheet}/values_batch_update`,
      "POST",
      {
        valueRanges: cells.map((cell) => ({
          range: `${table.sheet.sheet_id}!${columnName(cell.column)}${row}:${columnName(cell.column)}${row}`,
          values: [[cell.value]],
        })),
      },
    );
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
