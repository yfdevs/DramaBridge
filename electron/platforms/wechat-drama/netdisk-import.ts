import ExcelJS from 'exceljs';
import type { NetdiskDramaInput } from '../../../src/platforms/wechat-drama/netdisk-types';

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
      const title = text('剧名'); let shareText = text('全集链接(100%)');
      if (!title && !shareText) continue;
      const episodeCount = Number(text('集数').replace(/集$/, ''));
      const rawLink = shareText.match(/https?:\/\/pan\.baidu\.com\/[^\s"'<>]+/)?.[0];
      let validLink = false;
      if (rawLink) {
        try {
          const url = new URL(rawLink);
          if (url.pathname === '/share/init') {
            const surl = url.searchParams.get('surl');
            if (surl && /^[a-zA-Z0-9_-]+$/.test(surl)) {
              url.pathname = '/s/1' + surl;
              url.searchParams.delete('surl');
            }
          }
          validLink = /^\/s\/[a-zA-Z0-9_-]+$/.test(url.pathname);
          if (validLink) shareText = shareText.replace(rawLink, url.toString());
        } catch { /* Report the field below. */ }
      }
      const invalid = [
        !title || title.length > 120 ? '剧名不能为空且不能超过 120 字' : '',
        !Number.isInteger(episodeCount) || episodeCount < 1 ? '集数必须为正整数（填写原剧总集数）' : '',
        !validLink ? '全集链接须为百度网盘 /s/ 或 /share/init?surl= 分享地址' : '',
      ].filter(Boolean);
      if (invalid.length) {
        errors.push(`${sheet.name} 第${row}行：${invalid.join('；')}`); continue;
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

export async function createWechatRecreationTemplate(file: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('视频号二创', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: '剧名', key: 'title', width: 28 },
    { header: '集数', key: 'count', width: 12 },
    { header: '全集链接(100%)', key: 'link', width: 70 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27272A' } };
  sheet.autoFilter = 'A1:C1';
  sheet.getColumn('count').numFmt = '0';
  sheet.getCell('B2').dataValidation = { type: 'whole', operator: 'between', formulae: [1, 10000], allowBlank: true,
    showErrorMessage: true, errorTitle: '集数无效', error: '请填写原剧总集数（正整数）' };
  const guide = workbook.addWorksheet('填写说明');
  guide.getColumn(1).width = 100;
  [
    '在“视频号二创”工作表中填写，一行一部剧，请保留列标题',
    '剧名、集数、全集链接(100%) 为必填项；集数填写原剧总集数',
    '全集链接填写百度网盘分享链接；有提取码时请一并粘贴在同一单元格',
    '仅生成一个版本，云端转存前 ceil(总集数 × 60%) 集，视频无需下载',
    '目录：/微信视频号60%素材汇总/剧名60%素材/成片60%；封面保存至同级“封面”目录',
  ].forEach(text => guide.addRow([text]));
  await workbook.xlsx.writeFile(file);
}
