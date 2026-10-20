import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDouyinDramaFailStage,
  douyinNetdiskOwnershipDownloadRequirements,
} from "../../src/app/runtime.js";

test("does not block netdisk completion on ambiguous ownership directory names", () => {
  assert.deepEqual(douyinNetdiskOwnershipDownloadRequirements, {
    minimumImages: 4,
  });
  assert.equal("minimumJianyingImages" in douyinNetdiskOwnershipDownloadRequirements, false);
});

test("maps netdisk and download failures to a backend-supported fail stage", () => {
  assert.equal(
    classifyDouyinDramaFailStage(new Error("DOUYIN_DRAMA_NETDISK_TEXT_REQUIRED")),
    "UPLOAD_FILE",
  );
  assert.equal(
    classifyDouyinDramaFailStage(new Error("百度网盘下载失败")),
    "UPLOAD_FILE",
  );
});

test("maps AI-generated role image failures to the upload stage", () => {
  assert.equal(
    classifyDouyinDramaFailStage(new Error("DOUYIN_DRAMA_AI_ROLE_IMAGE_GENERATION_FAILED")),
    "UPLOAD_FILE",
  );
});
