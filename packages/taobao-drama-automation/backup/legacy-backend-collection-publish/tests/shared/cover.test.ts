// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DramaAiClient, ImageGenerationOptions } from "@dramabridge/ai";
import { readImageDimensions } from "@dramabridge/media-assets";

import { prepareTaobaoCollectionCover } from "../../src/shared/cover.js";
import type { ClaimedTaobaoDramaTask } from "../../src/shared/types.js";

const onePixelImage = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#ff6a00"/></svg>',
);

test("generates an exact 1080x1800 cover without requiring a source poster", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taobao-cover-test-"));
  let request: ImageGenerationOptions | undefined;
  const aiClient: DramaAiClient = {
    async generateImage(options) {
      request = options;
      return { model: "test-image-model", images: [{ data: onePixelImage, mimeType: "image/svg+xml" }] };
    },
    async analyzeImages() {
      throw new Error("not used");
    },
    async generateText() {
      throw new Error("not used");
    },
  };
  const task: ClaimedTaobaoDramaTask = {
    accountTaskId: 88,
    originalTitle: "逆风翻盘",
    playlet: {
      title: "逆风翻盘",
      summary: "女主从低谷重新出发并改变人生。",
      episodeCount: 60,
      shortDramaType: "AI仿真人短剧",
      shortDramaTags: ["都市", "AI真人演绎剧", "逆袭"],
      audience: "女",
    },
  };

  try {
    const cover = await prepareTaobaoCollectionCover(task, {
      aiClient,
      aiImageModel: "test-image-model",
      assetDownloadDir: path.join(root, "assets"),
      localMaterialRoot: path.join(root, "materials"),
    });
    assert.deepEqual(await readImageDimensions(cover), { width: 1080, height: 1800 });
    assert.equal(request?.size, "1080x1800");
    assert.equal(request?.referenceImages, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
