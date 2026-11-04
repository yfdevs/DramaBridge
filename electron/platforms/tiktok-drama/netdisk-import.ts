import ExcelJS from 'exceljs';
import type { NetdiskDramaInput } from '../../../src/platforms/tiktok-drama/netdisk-types';

export function excelCellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value).trim();
  if ('hyperlink' in value) return String(value.hyperlink || value.text || '').trim();
  if ('richText' in value) return value.richText.map(part => part.text).join('').trim();
  if ('result' in value) return excelCellText(value.result as ExcelJS.CellValue);
  return '';
}

export async function readNetdiskDramaWorkbook(file: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const records: NetdiskDramaInput[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const sheet of workbook.worksheets) {
    let columns = new Map<string, number>();
    let headerRow = 0;
    for (let row = 1; row <= Math.min(20, sheet.rowCount); row++) {
      const candidate = new Map<string, number>();
      sheet.getRow(row).eachCell((cell, column) => candidate.set(excelCellText(cell.value).replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')'), column));
      if (candidate.has('剧名') && candidate.has('全集链接(100%)') && candidate.has('集数')) {
        columns = candidate; headerRow = row; break;
      }
    }
    if (!headerRow) continue;
    for (let row = headerRow + 1; row <= sheet.rowCount; row++) {
      const text = (key: string) => columns.has(key) ? excelCellText(sheet.getRow(row).getCell(columns.get(key)!).value) : '';
      const title = text('剧名'); const shareText = text('全集链接(100%)');
      if (!title && !shareText) continue;
      const episodeCount = Number(text('集数').replace(/集$/, ''));
      const link = shareText.match(/https?:\/\/pan\.baidu\.com\/s\/[^\s"'<>]+/)?.[0];
      if (!title || title.length > 120 || !Number.isInteger(episodeCount) || episodeCount < 1 || !link) {
        errors.push(`${sheet.name} 第${row}行：剧名、集数或全集链接无效`); continue;
      }
      const key = title + '\n' + shareText;
      if (seen.has(key)) { errors.push(`${sheet.name} 第${row}行：重复剧目，已跳过`); continue; }
      seen.add(key);
      records.push({ title, shareText, episodeCount, copyright: text('版权方'), production: text('制作类型'),
        subject: text('题材'), genre: text('类型'), description: text('简介'), flatLink: text('单层文件夹链接'),
        sheet: sheet.name, sourceRow: row });
    }
  }
  if (!records.length) throw new Error(errors[0] || '未找到包含“剧名、集数、全集链接(100%)”的有效数据');
  return { records, errors };
}
