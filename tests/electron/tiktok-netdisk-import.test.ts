import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readNetdiskDramaWorkbook } from '../../electron/platforms/tiktok-drama/netdisk-import';
import { createNetdiskDramaExport } from '../../electron/platforms/tiktok-drama/netdisk-export';
import type { NetdiskDramaRecord } from '../../src/platforms/tiktok-drama/netdisk-types';

test('imports offset headers, hyperlinks, rich text and all metadata; reports invalid and duplicate rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tiktok-import-'));
  try {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('剧单');
    sheet.addRow([null, null, '版权方', '集数', '剧名', '全集链接（100%）', '简介']);
    const row = [null, null, '版权方A', 2, { richText: [{ text: '测试' }, { text: '剧' }] },
      { text: '点击获取', hyperlink: 'https://pan.baidu.com/s/1test?pwd=abcd' }, '故事'];
    sheet.addRow(row); sheet.addRow(row);
    sheet.addRow([null, null, '', '不明', '坏剧', '不是链接']);
    const file = path.join(directory, '剧单.xlsx'); await workbook.xlsx.writeFile(file);
    const result = await readNetdiskDramaWorkbook(file);
    assert.equal(result.records.length, 1); assert.equal(result.errors.length, 2);
    assert.equal(result.records[0].title, '测试剧'); assert.equal(result.records[0].copyright, '版权方A');
    assert.equal(result.records[0].sourceRow, 2); assert.equal(result.records[0].description, '故事');
    assert.match(result.records[0].shareText, /pwd=abcd/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('export preserves the supplied column offset and layout, includes failed rows and round-trips', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tiktok-export-'));
  try {
    const template = new ExcelJS.Workbook(), sheet = template.addWorksheet('Sheet1');
    sheet.getColumn(12).width = 40;
    sheet.addRow([null, null, null, null, null, null, '版权方', '制作类型', '集数', '题材', '类型', '剧名', '简介', '全集链接(100%)', '单层文件夹链接']);
    sheet.getRow(1).font = { bold: true };
    sheet.addRow([null, null, null, null, null, null, '应删除的旧数据']);
    const record = { title: '导出剧', episodeCount: 2, shareText: 'https://pan.baidu.com/s/1test?pwd=abcd',
      copyright: '版权方A', production: '竖屏', subject: '逆袭', genre: 'AI真人', description: '故事',
      flatLink: '原来的单层链接', generatedLink: 'https://pan.baidu.com/s/1saved?pwd=abcd', sheet: 'Sheet1', sourceRow: 2, status: 'succeeded' } as NetdiskDramaRecord;
    const exported = await createNetdiskDramaExport([record], Buffer.from(await template.xlsx.writeBuffer()));
    const file = path.join(directory, '导出.xlsx'); await exported.xlsx.writeFile(file);
    const checked = new ExcelJS.Workbook(); await checked.xlsx.readFile(file);
    const result = checked.worksheets[0];
    assert.equal(result.getColumn(12).width, 40);
    assert.equal(result.getRow(1).getCell(7).font.bold, true);
    assert.equal(result.getRow(2).getCell(7).value, '版权方A');
    assert.equal(result.getRow(2).getCell(12).value, '导出剧');
    assert.equal(result.getRow(2).getCell(14).value, record.shareText);
    assert.equal(result.getRow(2).getCell(15).value, record.generatedLink);
    assert.equal(record.flatLink, '原来的单层链接', 'the imported data remains intact');
    assert.equal((await readNetdiskDramaWorkbook(file)).records.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
