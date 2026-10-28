import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { prepareWechatImageUploadMaterials } from "../../src/shared/image-materials.js";
import {
  configureWechatVideoRuntimeSettings,
  defaultWechatVideoRuntimeSettings,
} from "../../src/shared/runtime-settings.js";
import type { Config } from "../../src/shared/types.js";

test("compresses oversized Wechat upload images once and leaves non-images unchanged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wechat-image-materials-"));
  const source = path.join(directory, "proof.png");
  const pdf = path.join(directory, "contract.pdf");
  try {
    await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toFile(source);
    await writeFile(pdf, "%PDF-1.4 test");
    configureWechatVideoRuntimeSettings({
      imageCompressionThresholdMegabytes: "0.1",
      imageCompressionTargetMegabytes: "0.08",
    });
    const config = {
      originalTitle: "测试剧",
      playlet: {
        posters: { main: source, promotion: source },
        aiProductionProofFiles: [source],
        copyright: { productionProofFiles: [source], licenseProofFiles: [path.join(directory, "missing-license.png")] },
        qualification: { type: "其他微短剧", proofFiles: [path.join(directory, "missing-qualification.png")] },
        otherMaterials: [path.join(directory, "missing-other.png")],
        productionCost: { amountWan: 30, proofFiles: [pdf, source] },
      },
    } as Config;

    await prepareWechatImageUploadMaterials({
      config,
      outputDir: path.join(directory, "output"),
    });

    assert.notEqual(config.playlet.posters.main, source);
    assert.equal(config.playlet.posters.promotion, config.playlet.posters.main);
    assert.equal(config.playlet.aiProductionProofFiles?.[0], config.playlet.posters.main);
    assert.equal(config.playlet.copyright.productionProofFiles?.[0], config.playlet.posters.main);
    assert.equal(config.playlet.copyright.licenseProofFiles?.[0], path.join(directory, "missing-license.png"));
    assert.equal(config.playlet.qualification.proofFiles?.[0], path.join(directory, "missing-qualification.png"));
    assert.equal(config.playlet.otherMaterials?.[0], path.join(directory, "missing-other.png"));
    assert.deepEqual(config.playlet.productionCost?.proofFiles, [pdf, config.playlet.posters.main]);
    assert.ok((await stat(config.playlet.posters.main)).size <= 80_000);
  } finally {
    configureWechatVideoRuntimeSettings(defaultWechatVideoRuntimeSettings);
    await rm(directory, { recursive: true, force: true });
  }
});
