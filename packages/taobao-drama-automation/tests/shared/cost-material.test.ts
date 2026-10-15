import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareTaobaoCostConfigImage } from "../../src/shared/cost-material.js";

test("converts the first page of a productionCost PDF to PNG for Taobao", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "taobao-cost-material-"));
  try {
    const sourcePdf = path.resolve(
      import.meta.dirname,
      "../../../tencent-huolong-drama-automation/src/assets/AI创作声明.pdf",
    );
    const output = await prepareTaobaoCostConfigImage({
      id: "task-1",
      originalTitle: "测试短剧",
      baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
      episodeCount: 1,
      productionCostProofFiles: [sourcePdf],
    }, {
      assetDownloadDir: outputRoot,
    });

    assert.equal(path.extname(output), ".png");
    assert.ok((await stat(output)).size > 0);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
