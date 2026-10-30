import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  createRecreationTemplate,
  readRecreationExcel,
} from "../../electron/platforms/kuaishou-drama/recreation-excel";

test("recreation template round-trips arbitrary version columns and rejects invalid rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recreation-excel-"));
  try {
    const file = path.join(dir, "template.xlsx");
    await createRecreationTemplate(file);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(file);
    const sheet = book.getWorksheet("二创任务")!;
    sheet.getCell("G1").value = "版本20";
    sheet.getRow(2).values = [
      "原剧",
      101,
      "https://pan.baidu.com/s/1test?pwd=abcd",
      "版本新名",
      "",
      "",
      "更多版本",
    ];
    await book.xlsx.writeFile(file);
    const inputs = await readRecreationExcel(file);
    assert.equal(inputs[0].episodeCount, 101);
    assert.deepEqual(inputs[0].versions, ["版本新名", "更多版本"]);
    sheet.addRow(["另一个剧", 0, "非法链接", "../逃逸"]);
    await book.xlsx.writeFile(file);
    await assert.rejects(readRecreationExcel(file), /第 3 行/);
    sheet.spliceRows(3, 1);
    sheet.getCell("D2").value = "原剧";
    await book.xlsx.writeFile(file);
    await assert.rejects(readRecreationExcel(file), /不能与原剧名相同/);
    sheet.getCell("D2").value = { formula: '"剧名"', result: "剧名" };
    await book.xlsx.writeFile(file);
    await assert.rejects(readRecreationExcel(file), /不支持公式/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
