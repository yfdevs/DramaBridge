import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDouyinDramaFailStage,
  douyinNetdiskOwnershipDownloadRequirements,
  ensureDouyinNetdiskResource,
} from "../../src/app/runtime.js";
import type { ClaimedDouyinDramaTask } from "../../src/shared/types.js";

const netdiskTask = {
  accountTaskId: 104,
  originalTitle: "停工令下，旧饭堂却坐满人",
  playlet: {
    title: "停工令下，旧饭堂却坐满人",
    summary: "测试简介",
    episodeCount: 62,
    baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
  },
} as ClaimedDouyinDramaTask;

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

test("maps an empty publish-account list to the form stage for backend reporting", () => {
  assert.equal(
    classifyDouyinDramaFailStage(
      new Error("DOUYIN_DRAMA_PUBLISH_ACCOUNT_OPTIONS_EMPTY: 发布账号没有可选项"),
    ),
    "FILL_FORM",
  );
});

test("fails a netdisk task after a bounded period without episode progress", async () => {
  let calls = 0;
  await assert.rejects(
    ensureDouyinNetdiskResource(netdiskTask, {
      localEpisodeVideoRoot: "D:\\BaiduNetdiskDownload",
      baiduNetdiskDownloadRetryAttempts: 3,
      baiduNetdiskDownloadStallTimeoutMs: 20,
      baiduNetdiskProgressLogIntervalMs: 5,
      ensureBaiduNetdiskResource: async (request) => {
        calls += 1;
        return await new Promise((resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
          void resolve;
        });
      },
    }),
    /DOUYIN_DRAMA_NETDISK_DOWNLOAD_STALLED/,
  );
  assert.equal(calls, 1, "a stalled download must not silently retry for another full timeout");
});

test("aborts an in-flight netdisk task when the runtime stops", async () => {
  const controller = new AbortController();
  const pending = ensureDouyinNetdiskResource(netdiskTask, {
    localEpisodeVideoRoot: "D:\\BaiduNetdiskDownload",
    baiduNetdiskDownloadStallTimeoutMs: 60_000,
    baiduNetdiskProgressLogIntervalMs: 60_000,
    ensureBaiduNetdiskResource: async (request) => await new Promise((resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
        once: true,
      });
      void resolve;
    }),
  }, controller.signal);

  controller.abort(new Error("DOUYIN_DRAMA_RUNTIME_STOPPED"));
  await assert.rejects(pending, /DOUYIN_DRAMA_RUNTIME_STOPPED/);
});
