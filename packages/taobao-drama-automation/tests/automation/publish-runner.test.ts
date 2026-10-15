import assert from "node:assert/strict";
import test from "node:test";

import { taobaoBaiduResourceRequest } from "../../src/automation/publish-runner.js";

test("requests collection materials and episode videos from Baidu for Taobao publishing", () => {
  const request = taobaoBaiduResourceRequest({
    id: "task-1",
    originalTitle: "测试短剧",
    baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
    episodeCount: 66,
  }, {
    localMaterialRoot: "D:\\短剧素材",
  });

  assert.equal(request.downloadAssetMaterials, true);
  assert.equal(request.forceAssetDownload, true);
  assert.equal(request.requireAllDiscoveredAssets, true);
  assert.equal(request.requiredMetadataTextFiles, 0);
  assert.equal(request.requiredPosterImages, 0);
  assert.equal(request.episodeCount, 66);
});
