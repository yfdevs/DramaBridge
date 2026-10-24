import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { classifyOwnershipOcrText, WindowsOwnershipOcr } from "../../electron/local-ownership-ocr.js";

test("uses explicit OCR identities and refuses ambiguous or unrelated text", () => {
  for (const text of ["C:\\drafts\\JianyingPro\\项目", "剪 映", "CapCut"]) {
    assert.equal(classifyOwnershipOcrText(text), "jianying");
  }
  for (const text of ["https://jimeng.jianying.com/ai-tool", "即梦 AI", "Seedance 2.0", "Guagu Studio", "火山引擎 分镜生成"]) {
    assert.equal(classifyOwnershipOcrText(text), "juchuang");
  }
  for (const text of ["剪映 即梦AI", "人物字幕和时间轴", "jianying", "火山引擎"]) {
    assert.equal(classifyOwnershipOcrText(text), "unknown");
  }
});

test("native availability test recognizes a generated image and releases its worker", { timeout: 30_000 }, async () => {
  const ocr = new WindowsOwnershipOcr();
  try {
    const result = await ocr.test();
    assert.equal(typeof result.available, "boolean");
    assert.ok(result.message);
    if (result.available) {
      assert.ok(result.latencyMs! >= 0);
      const directory = await mkdtemp(path.join(os.tmpdir(), "ocr-crop-test-"));
      try {
        const file = path.join(directory, "image.jpg");
        await sharp(Buffer.from('<svg width="1920" height="1040"><rect width="100%" height="100%" fill="white"/><text x="1450" y="240" font-family="Arial" font-size="32" fill="black">JianyingPro</text></svg>')).jpeg().toFile(file);
        assert.equal(await ocr.classify(file), "jianying");
        assert.equal(await ocr.classify(file), "jianying");
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    assert.equal(await ocr.classify("Z:\\missing-ocr-image.png"), "unknown");
  } finally { ocr.stop(); }
  assert.equal(await ocr.classify("Z:\\missing-ocr-image.png"), "unknown");
});
