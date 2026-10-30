import ExcelJS from "exceljs";
import type { RecreationInput } from "../../../src/platforms/kuaishou-drama/recreation-types";

// Names are used unchanged on Windows and in Baidu Netdisk, so reject lossy names.
export function validateRecreationTitle(value: string) {
  if (
    !value ||
    value.length > 80 ||
    /[<>:"/\\|?*]/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("剧名须为 1–80 字，不能包含路径或 Windows 文件名禁用字符");
  }
}

export function validateRecreationInput(input: RecreationInput) {
  validateRecreationTitle(input.originalTitle);
  if (
    !Number.isSafeInteger(input.episodeCount) ||
    input.episodeCount < 1 ||
    input.episodeCount > 10000
  )
    throw new Error("集数须为 1–10000 的整数");
  if (!/https:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/.test(input.shareText))
    throw new Error("百度链接须包含有效的 pan.baidu.com/s/ 分享链接，可附提取码");
  input.versions.forEach(validateRecreationTitle);
  const titles = [input.originalTitle, ...input.versions].map((title) => title.toLocaleLowerCase());
  if (new Set(titles).size !== titles.length)
    throw new Error("版本名称不能重复，也不能与原剧名相同");
}

export async function createRecreationTemplate(file: string) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("二创任务", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = ["原剧名", "集数", "百度链接", "版本1", "版本2", "版本3"].map(
    (header, index) => ({ header, width: index === 2 ? 65 : index === 1 ? 12 : 26 }),
  );
  sheet.getRow(1).font = { bold: true, color: { argb: "FF262626" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
  sheet.getRow(1).height = 26;
  sheet.getCell("B2").dataValidation = {
    type: "whole",
    operator: "between",
    formulae: [1, 10000],
    showErrorMessage: true,
    error: "请填写正整数集数",
  };
  const help = book.addWorksheet("填写说明");
  [
    "在“二创任务”中填写数据，一行一个任务，不要修改前三列标题。",
    "集数填写原剧总集数；下载前 ceil(集数 × 60%) 集。",
    "百度链接可粘贴完整分享文本，包含提取码。",
    "版本列填写新剧名；可在右侧继续添加版本4、版本5等列。",
    "每个任务自动包含原剧名版本；版本列可以留空。",
    "同名原剧仅允许导入一次；有错误时整批不导入，修正后重试。",
    "仅复制封面、重命名视频，不改动视频画面或封面内容。",
  ].forEach((line) => help.addRow([line]));
  help.getColumn(1).width = 100;
  await book.xlsx.writeFile(file);
}

export async function readRecreationExcel(file: string): Promise<RecreationInput[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  const sheet = book.getWorksheet("二创任务") ?? book.worksheets[0];
  if (!sheet) throw new Error("Excel 中没有工作表");
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cell.text.trim();
  });
  if (["原剧名", "集数", "百度链接"].some((name, index) => headers[index] !== name))
    throw new Error("前三列必须依次为：原剧名、集数、百度链接");
  const versionColumns = headers.flatMap((header, index) =>
    /^版本[1-9]\d*$/.test(header) ? [index + 1] : [],
  );
  if (headers.some((header, index) => index > 2 && header && !/^版本[1-9]\d*$/.test(header)))
    throw new Error("版本列标题请使用版本1、版本2、版本3……");
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length)
    throw new Error("Excel 列标题不能重复");
  const inputs: RecreationInput[] = [];
  const errors: string[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || !row.values || row.actualCellCount === 0) return;
    let hasText = false;
    row.eachCell((cell) => {
      if (cell.text.trim()) hasText = true;
    });
    if (!hasText) return;
    try {
      row.eachCell((cell) => {
        if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error)
          throw new Error("请填写实际值，不支持公式或错误单元格");
      });
      const input = {
        originalTitle: row.getCell(1).text.trim(),
        episodeCount: Number(row.getCell(2).text),
        shareText: row.getCell(3).text.trim(),
        versions: versionColumns.map((col) => row.getCell(col).text.trim()).filter(Boolean),
      };
      validateRecreationInput(input);
      inputs.push(input);
    } catch (error) {
      errors.push(`第 ${rowNumber} 行：${(error as Error).message}`);
    }
  });
  if (errors.length) throw new Error(errors.slice(0, 20).join("\n"));
  if (!inputs.length) throw new Error("没有可导入的任务，请先填写模板");
  return inputs;
}
