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

test("passes the per-task redownload switch only to the full resource download", async () => {
  for (const enabled of [undefined, false, true]) {
    const requests: Array<{ forceRedownload?: boolean }> = [];
    const task = {
      ...netdiskTask,
      playlet: { ...netdiskTask.playlet, baiduNetdiskRedownload: enabled, summary: "简介".repeat(60), roles: [{ name: "主角", intro: "人物简介" }] },
    };
    await ensureDouyinNetdiskResource(task, {
      localEpisodeVideoRoot: "D:\\BaiduNetdiskDownload",
      ensureBaiduNetdiskResource: async request => {
        requests.push(request);
        return { skippedExisting: !request.forceRedownload };
      },
    });
    assert.equal(requests[0]?.forceRedownload, enabled === true);
  }
});

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

test("waits for the shared download service even without stable episode callbacks", async () => {
  const task = { ...netdiskTask, playlet: { ...netdiskTask.playlet,
    summary: "简介".repeat(60), roles: [{ name: "主角", intro: "人物简介" }] } };
  const originalNow = Date.now;
  let calls = 0;
  try {
    let now = originalNow();
    Date.now = () => now;
    await ensureDouyinNetdiskResource(task, {
      localEpisodeVideoRoot: "D:\\BaiduNetdiskDownload",
      baiduNetdiskProgressLogIntervalMs: 5,
      ensureBaiduNetdiskResource: async request => {
        calls++;
        now += 11 * 60_000;
        await new Promise(resolve => setTimeout(resolve, 30));
        request.signal?.throwIfAborted();
        return {};
      },
    });
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("aborts an in-flight netdisk task when the runtime stops", async () => {
  const controller = new AbortController();
  const pending = ensureDouyinNetdiskResource(netdiskTask, {
    localEpisodeVideoRoot: "D:\\BaiduNetdiskDownload",
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


test("classifies an unbound-contract form warning as form validation rather than file upload", () => {
  assert.equal(classifyDouyinDramaFailStage(new Error("DOUYIN_DRAMA_FORM_ERROR: 关联线索点击下一步: 请完成合同绑定")), "FILL_FORM");
});
