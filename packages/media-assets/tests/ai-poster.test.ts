import type { DramaAiClient, ImageGenerationOptions } from "@dramabridge/ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildMissingPosterPrompt, ensureAiPoster } from "../src/ai-poster.js";
import { evaluateCommercialPosterTextValidation } from "../src/poster-text-validation.js";
import { listLocalPosterImages } from "../src/index.js";

function fakeClient(source: Buffer) {
  let calls = 0;
  const requests: ImageGenerationOptions[] = [];
  const client = {
    analyzeImages: async () => {
      throw new Error("not implemented");
    },
    generateImage: async (options: ImageGenerationOptions) => {
      calls += 1;
      requests.push(options);
      return {
        images: [{ data: source, mimeType: "image/png" }],
        model: options.model || "test-image-model",
      };
    },
    generateText: async () => {
      throw new Error("not implemented");
    },
  } satisfies DramaAiClient;
  return { client, getCalls: () => calls, requests };
}

test("preserves the generated source dimensions and format and reuses the matching cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-ai-poster-"));
  try {
    const source = await sharp({
      create: {
        background: "#7f1d1d",
        channels: 3,
        height: 900,
        width: 1600,
      },
    }).png().toBuffer();
    const fake = fakeClient(source);
    const options = {
      client: fake.client,
      localMaterialRoot: root,
      model: "test-image-model",
      resourceName: "测试短剧",
      summary: "主角在绝境中觉醒能力，揭开阴谋并完成逆袭。",
      title: "测试短剧",
    };

    const [first, concurrent] = await Promise.all([
      ensureAiPoster(options),
      ensureAiPoster(options),
    ]);
    const second = await ensureAiPoster(options);
    const metadata = await sharp(first.file).metadata();
    const fileStat = await stat(first.file);
    const savedData = await readFile(first.file);
    const discoveredPosters = await listLocalPosterImages({
      root,
      resourceName: "测试短剧",
    });

    assert.equal(fake.getCalls(), 1);
    assert.equal(first.file, concurrent.file);
    assert.equal(second.reused, true);
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 900);
    assert.equal(metadata.format, "png");
    assert.deepEqual(savedData, source);
    assert.equal(discoveredPosters[0]?.file, first.file);
    assert.equal(fileStat.size, source.length);
    assert.match(first.file, /海报封面/);
    assert.match(first.file, /AI海报\.png$/);
    assert.equal(fake.requests[0]?.size, undefined);
    assert.match(fake.requests[0]?.prompt ?? "", /剧名：测试短剧/);
    assert.match(fake.requests[0]?.prompt ?? "", /主角在绝境中觉醒能力/);
    assert.match(fake.requests[0]?.prompt ?? "", /地点、年代、人物身份/);
    assert.match(fake.requests[0]?.prompt ?? "", /分辨率、尺寸/);
    assert.doesNotMatch(fake.requests[0]?.prompt ?? "", /整张图只能出现这一处|除上述唯一剧名外/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows commercial poster copy and title OCR split across segments", () => {
  const result = evaluateCommercialPosterTextValidation("吾儿亲启，珠间血海", {
    titlePresent: false,
    titleReadable: false,
    titleSeverelyIncorrect: true,
    hasProhibitedOverlay: false,
    hasClearlyUnrelatedOrGibberishText: false,
    detectedTexts: ["吾儿亲启", "吾儿亲启", "珠间血海", "扬州"],
    blockingIssues: [
      "未出现带逗号的完整准确剧名",
      "剧名多次重复出现，不符合只出现一次的要求",
      "存在无关文字“扬州”",
      "存在无关文字“苏州”",
    ],
    warnings: [],
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 4);
});

test("rejects only clearly unsuitable cover text", () => {
  const result = evaluateCommercialPosterTextValidation("正确剧名", {
    titlePresent: false,
    titleReadable: false,
    titleSeverelyIncorrect: true,
    hasProhibitedOverlay: true,
    hasClearlyUnrelatedOrGibberishText: true,
    detectedTexts: ["另一部短剧", "扫码加微信", "1920x1080"],
    blockingIssues: ["出现另一部作品名称"],
    warnings: [],
  });

  assert.equal(result.passed, false);
  assert.match(result.failures.join("；"), /未检测到完整剧名/);
  assert.match(result.failures.join("；"), /广告、水印、二维码或技术界面文字/);
  assert.match(result.failures.join("；"), /其他作品文字或乱码/);
});

test("shared missing-poster prompt permits relevant supporting copy", () => {
  const prompt = buildMissingPosterPrompt("测试短剧", "发生在扬州的逆袭故事。");
  assert.match(prompt, /地点、年代、人物身份/);
  assert.match(prompt, /其他作品名称、乱码、联系方式/);
  assert.doesNotMatch(prompt, /整张图只能出现这一处|除上述唯一剧名外/);
});

test("regenerates when the synopsis changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-ai-poster-"));
  try {
    const source = await sharp({
      create: {
        background: "#1d4ed8",
        channels: 3,
        height: 800,
        width: 600,
      },
    }).png().toBuffer();
    const fake = fakeClient(source);
    const base = {
      client: fake.client,
      localMaterialRoot: root,
      model: "test-image-model",
      resourceName: "同名短剧",
      title: "同名短剧",
    };

    await ensureAiPoster({ ...base, summary: "第一版剧情简介。" });
    const regenerated = await ensureAiPoster({ ...base, summary: "第二版剧情简介。" });

    assert.equal(fake.getCalls(), 2);
    assert.equal(regenerated.reused, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the configured AI cover retry count after the first failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-ai-poster-retry-"));
  try {
    const source = await sharp({
      create: {
        background: "#166534",
        channels: 3,
        height: 900,
        width: 1600,
      },
    }).png().toBuffer();
    let calls = 0;
    const client = {
      analyzeImages: async () => {
        throw new Error("not implemented");
      },
      generateImage: async (options: ImageGenerationOptions) => {
        calls += 1;
        if (calls < 3) throw new Error(`temporary failure ${calls}`);
        return {
          images: [{ data: source, mimeType: "image/png" }],
          model: options.model || "test-image-model",
        };
      },
      generateText: async () => {
        throw new Error("not implemented");
      },
    } satisfies DramaAiClient;

    const result = await ensureAiPoster({
      client,
      localMaterialRoot: root,
      model: "test-image-model",
      resourceName: "重试配置测试剧",
      retryAttempts: 2,
      summary: "前两次生成失败，第三次成功。",
      title: "重试配置测试剧",
    });

    assert.equal(calls, 3);
    assert.ok((await stat(result.file)).size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes episode frames to image generation and includes them in the cache identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-ai-poster-frames-"));
  try {
    const generatedSource = await sharp({
      create: { background: "#111827", channels: 3, height: 900, width: 1600 },
    }).png().toBuffer();
    const referenceDir = path.join(root, "references");
    await mkdir(referenceDir, { recursive: true });
    const firstFrame = path.join(referenceDir, "frame-1.jpg");
    const secondFrame = path.join(referenceDir, "frame-2.jpg");
    await writeFile(firstFrame, generatedSource);
    await writeFile(secondFrame, generatedSource);
    const fake = fakeClient(generatedSource);
    const base = {
      client: fake.client,
      localMaterialRoot: root,
      model: "test-image-model",
      resourceName: "参考帧测试剧",
      summary: "男女主在第一集相遇并卷入一场身份危机。",
      title: "参考帧测试剧",
    };

    await ensureAiPoster({ ...base, referenceImages: [firstFrame, secondFrame] });
    await ensureAiPoster({ ...base, referenceImages: [firstFrame] });

    assert.equal(fake.getCalls(), 2);
    assert.deepEqual(fake.requests[0]?.referenceImages, [
      { type: "file", path: firstFrame },
      { type: "file", path: secondFrame },
    ]);
    assert.match(fake.requests[0]?.prompt ?? "", /2 张第一集随机画面/);
    assert.match(fake.requests[0]?.prompt ?? "", /不要直接拼贴截图/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
