import ExcelJS from 'exceljs';
import type { NetdiskDramaRecord } from '../../../src/platforms/wechat-drama/netdisk-types';
import { excelCellText } from './netdisk-import';

export async function createNetdiskDramaExport(records: NetdiskDramaRecord[], template?: Buffer) {
  const workbook = new ExcelJS.Workbook();
  if (template) await workbook.xlsx.load(template as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const normalize = (text: string) => text.replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
  const found = workbook.worksheets.flatMap(sheet => {
    for (let row = 1; row <= Math.min(20, sheet.rowCount); row++) {
      const columns = new Map<string, number>();
      sheet.getRow(row).eachCell((cell, col) => columns.set(normalize(excelCellText(cell.value)), col));
      if (columns.has('剧名') && columns.has('全集链接(100%)')) return [{ sheet, row, columns }];
    }
    return [];
  })[0];
  const sheet = found?.sheet ?? workbook.addWorksheet('Sheet1');
  const headerRow = found?.row ?? 1;
  const headers = ['版权方', '制作类型', '集数', '题材', '类型', '剧名', '简介', '全集链接(100%)', '单层文件夹链接'];
  const columns = found?.columns ?? new Map(headers.map((key, index) => [key, index + 7]));
  if (!found) for (const [key, column] of columns) sheet.getRow(headerRow).getCell(column).value = key;
  // Preserve the supplied header, column widths, styles and header offset.
  // Remove source rows and other sheets so exports contain only the selected import dates.
  for (const other of [...workbook.worksheets]) if (other.id !== sheet.id) workbook.removeWorksheet(other.id);
  const sourceStyle = sheet.getRow(headerRow + 1);
  const height = sourceStyle.height;
  const styles = new Map<number, Partial<ExcelJS.Style>>();
  sourceStyle.eachCell({ includeEmpty: true }, (cell, column) => styles.set(column, structuredClone(cell.style)));
  const model = sheet.model as ExcelJS.WorksheetModel & { rows: Array<{ number: number }> };
  model.rows = model.rows.filter(row => row.number <= headerRow);
  model.merges = (model.merges ?? []).filter(range => Number(range.match(/(\d+)$/)?.[1]) <= headerRow);
  sheet.model = model;
  for (const record of records) {
    const row = sheet.addRow([]); row.height = height;
    const values: Record<string, string | number> = { '版权方': record.copyright, '制作类型': record.production,
      '集数': record.episodeCount, '题材': record.subject, '类型': record.genre, '剧名': record.title,
      '简介': record.description, '全集链接(100%)': record.shareText, '单层文件夹链接': record.generatedLink || record.flatLink };
    for (const [key, column] of columns) {
      const cell = row.getCell(column); cell.style = structuredClone(styles.get(column) ?? {});
      cell.value = values[key] ?? '';
    }
  }
  return workbook;
}
