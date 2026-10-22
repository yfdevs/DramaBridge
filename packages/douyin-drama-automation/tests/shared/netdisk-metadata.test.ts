import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safeFileName } from "@dramabridge/file-utils";
import { createMockDouyinNetdiskTestTask } from "../../src/api/mock-task.js";
import {
  collectDouyinNetdiskMetadataInputs,
  enrichDouyinTaskFromNetdisk,
} from "../../src/shared/netdisk-metadata.js";
import type { DouyinDramaAiClient } from "../../src/shared/types.js";

function fakeAiClient(
  responseText: string,
  onGenerate: () => void,
  onGenerateImage?: (
    options: Parameters<NonNullable<DouyinDramaAiClient["generateImage"]>>[0],
  ) => void,
): DouyinDramaAiClient {
  return {
    async generateText() {
      onGenerate();
      return { finishReason: "stop", model: "fake-text-model", text: responseText };
    },
    async generateImage(options) {
      onGenerateImage?.(options);
      return {
        model: options.model ?? "fake-image-model",
        images: [{ data: Buffer.from("fake-generated-role-image"), mimeType: "image/png" }],
      };
    },
  };
}

test("uses one AI text call to produce synopsis, roles, and filename-matched avatars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-netdisk-metadata-"));
  const task = createMockDouyinNetdiskTestTask();
  const resourceDir = path.join(root, task.originalTitle);
  const originalImageDir = path.join(resourceDir, "海报封面", "原始图片");
  const textDir = path.join(resourceDir, "海报封面", "剧情资料");
  await mkdir(originalImageDir, { recursive: true });
  await mkdir(textDir, { recursive: true });
  await writeFile(path.join(originalImageDir, "男主：刘晓-角色头像.png"), "fake-image");
  await writeFile(path.join(originalImageDir, "货主.jpeg"), "fake-image");
  await writeFile(
    path.join(textDir, "剧情及角色介绍.txt"),
    "刘晓是一名货车司机，长期被货主当作免费运输工具，最终决定收回车辆。货主是主要矛盾推动者。",
  );
  const summary = (
    "刘晓经营货车运输，却长期被人以人情为由当成免费的拉货工具。面对货主一次次得寸进尺，他终于选择收回车辆，拒绝继续无偿付出，并在冲突中守住自己的劳动成果与生活边界。"
      + "故事围绕他的觉醒与反抗展开，呈现普通劳动者维护尊严、重新掌握人生方向的过程。"
  ).slice(0, 190);
  let calls = 0;
  const response = JSON.stringify({
    summary,
    roles: [
      {
        name: "刘晓",
        roleType: "主角",
        intro: "货车司机，从一味忍让转向维护自身权益。",
        photoImageId: "image-1",
      },
      {
        name: "货主",
        roleType: "配角",
        intro: "不断提出无偿运输要求，是剧情矛盾的主要推动者。",
        // Exercise the deterministic filename fallback when the AI omits an id.
        photoImageId: null,
      },
    ],
  });

  try {
    const enriched = await enrichDouyinTaskFromNetdisk(task, {
      localEpisodeVideoRoot: root,
      aiClientFactory: () => fakeAiClient(response, () => { calls += 1; }),
    });
    assert.equal(calls, 1);
    assert.equal(enriched.playlet.summary, summary);
    assert.equal(enriched.playlet.roles.length, 2);
    assert.equal(enriched.playlet.roles[0]?.roleType, "主角");
    assert.equal(
      enriched.playlet.roles[0]?.photoFile,
      path.join(originalImageDir, "男主：刘晓-角色头像.png"),
    );
    assert.equal(enriched.playlet.roles[1]?.photoFile, path.join(originalImageDir, "货主.jpeg"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generates a role portrait when fewer than two netdisk role images can be matched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-netdisk-role-images-"));
  const task = createMockDouyinNetdiskTestTask();
  const resourceDir = path.join(root, task.originalTitle);
  const originalImageDir = path.join(resourceDir, "海报封面", "原始图片");
  const textDir = path.join(resourceDir, "海报封面", "剧情资料");
  await mkdir(originalImageDir, { recursive: true });
  await mkdir(textDir, { recursive: true });
  await writeFile(path.join(originalImageDir, "刘晓.png"), "fake-image");
  const referenceCover = path.join(resourceDir, "海报封面", "测试剧-海报.jpg");
  await writeFile(referenceCover, "fake-cover");
  await writeFile(path.join(textDir, "简介.txt"), "刘晓是货车司机，货主长期要求他免费拉货。", "utf8");
  const response = JSON.stringify({
    summary: "刘晓经营货车运输，却长期被人以人情为由当成免费的拉货工具。面对货主一次次得寸进尺，他终于选择收回车辆，拒绝继续无偿付出，并在冲突中守住自己的劳动成果与生活边界。故事围绕他的觉醒与反抗展开，呈现普通劳动者维护尊严并重新掌握人生方向的过程。",
    roles: [
      { name: "刘晓", roleType: "主角", intro: "货车司机。", photoImageId: "image-1" },
      { name: "货主", roleType: "配角", intro: "矛盾推动者。", photoImageId: null },
    ],
  });

  let imageCalls = 0;
  try {
    const enriched = await enrichDouyinTaskFromNetdisk(task, {
      localEpisodeVideoRoot: root,
      aiImageModelFactory: () => "fake-image-model",
      aiClientFactory: () => fakeAiClient(
        response,
        () => undefined,
        (imageOptions) => {
          imageCalls += 1;
          const prompt = imageOptions.prompt;
          assert.match(prompt, /角色姓名：货主/u);
          assert.match(prompt, /剧情简介：刘晓经营货车运输/u);
          assert.match(prompt, /判断参考封面属于真人实拍、写实AI、动漫、插画或3D/u);
          assert.match(prompt, /严格保持与封面一致/u);
          assert.deepEqual(imageOptions.referenceImages, [
            { type: "file", path: referenceCover, detail: "high" },
          ]);
        },
      ),
    });
    assert.equal(imageCalls, 1);
    assert.equal(enriched.playlet.roles.length, 2);
    assert.equal(enriched.playlet.roles[0]?.photoFile, path.join(originalImageDir, "刘晓.png"));
    assert.match(enriched.playlet.roles[1]?.photoFile ?? "", /AI角色头像-货主-/u);
    assert.ok((await stat(enriched.playlet.roles[1]!.photoFile!)).size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires a netdisk text file when the backend synopsis is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-netdisk-no-text-"));
  const task = createMockDouyinNetdiskTestTask();
  await mkdir(path.join(root, task.originalTitle), { recursive: true });
  let calls = 0;
  try {
    await assert.rejects(
      enrichDouyinTaskFromNetdisk(task, {
        localEpisodeVideoRoot: root,
        aiClientFactory: () => fakeAiClient("{}", () => { calls += 1; }),
      }),
      /DOUYIN_DRAMA_NETDISK_TEXT_REQUIRED/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collects preserved original image names and TXT content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-netdisk-collect-"));
  const image = path.join(root, "海报封面", "原始图片", "女主-小雨.jpg");
  const text = path.join(root, "海报封面", "剧情资料", "简介.txt");
  await mkdir(path.dirname(image), { recursive: true });
  await mkdir(path.dirname(text), { recursive: true });
  await writeFile(image, "image");
  await writeFile(text, "这是剧情简介和角色说明。", "utf8");
  try {
    const inputs = await collectDouyinNetdiskMetadataInputs(root);
    assert.equal(inputs.images[0]?.fileName, "女主-小雨.jpg");
    assert.equal(inputs.texts[0]?.content, "这是剧情简介和角色说明。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads downloaded synopsis using the original title with a full-width comma", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-title-punctuation-"));
  const title = "我卖老宅供她开店，她让我睡美容床";
  const downloadDir = path.join(root, safeFileName(title, { replacement: "_" }));
  try {
    const textDir = path.join(downloadDir, "海报封面", "剧情资料");
    await mkdir(textDir, { recursive: true });
    await writeFile(path.join(textDir, "简介.txt"), "四达美容院的剧情简介。", "utf8");
    const inputs = await collectDouyinNetdiskMetadataInputs(path.join(root, title));
    assert.equal(inputs.texts[0]?.content, "四达美容院的剧情简介。");
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("douyin-title-punctuation-"));
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing, short and unreadable synopsis sources accurately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-synopsis-errors-"));
  const task = createMockDouyinNetdiskTestTask();
  const resourceDir = path.join(root, task.originalTitle);
  try {
    await mkdir(resourceDir, { recursive: true });
    task.playlet.summary = "";
    await assert.rejects(enrichDouyinTaskFromNetdisk(task, { localEpisodeVideoRoot: root }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /百度网盘链接.*“短剧信息填写”中也未提供简介/u);
      assert.doesNotMatch(error.message, /后端/u);
      return true;
    });
    task.playlet.summary = "简短介绍";
    await assert.rejects(enrichDouyinTaskFromNetdisk(task, { localEpisodeVideoRoot: root }), /简介不足 101 字（当前 4 字）/u);
    await writeFile(path.join(resourceDir, "简介.docx"), "invalid docx");
    await assert.rejects(enrichDouyinTaskFromNetdisk(task, { localEpisodeVideoRoot: root }), /DOUYIN_DRAMA_NETDISK_TEXT_UNREADABLE.*已找到百度网盘简介文件.*简介.docx/u);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("douyin-synopsis-errors-"));
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable files do not exhaust the readable synopsis file limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-readable-synopsis-"));
  try {
    for (let index = 0; index < 11; index++) {
      await writeFile(path.join(root, `简介-${index}.doc`), "legacy binary doc");
    }
    await writeFile(path.join(root, "简介-99.txt"), "有效剧情简介", "utf8");
    const inputs = await collectDouyinNetdiskMetadataInputs(root);
    assert.equal(inputs.texts[0]?.content, "有效剧情简介");
    assert.equal(inputs.textReadFailures.length, 11);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("douyin-readable-synopsis-"));
    await rm(root, { recursive: true, force: true });
  }
});

test("collects RTF synopsis content and prioritizes synopsis directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "douyin-netdisk-rtf-"));
  const unrelated = path.join(root, "其他", "说明.txt");
  const synopsis = path.join(root, "海报封面", "剧情资料", "剧情简介.rtf");
  await mkdir(path.dirname(unrelated), { recursive: true });
  await mkdir(path.dirname(synopsis), { recursive: true });
  await writeFile(unrelated, "无关说明", "utf8");
  await writeFile(synopsis, String.raw`{\rtf1\ansi \u21095?\u24773?\u31616?\u20171?\par \u20027?\u35201?\u35282?\u33394?}`, "ascii");
  try {
    const inputs = await collectDouyinNetdiskMetadataInputs(root);
    assert.equal(inputs.texts[0]?.fileName, "剧情简介.rtf");
    assert.match(inputs.texts[0]?.content ?? "", /剧情简介/u);
    assert.match(inputs.texts[0]?.content ?? "", /主要角色/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
