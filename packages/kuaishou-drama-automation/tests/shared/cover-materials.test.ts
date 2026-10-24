import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  DramaAiClient,
  ImageGenerationOptions,
} from "@dramabridge/ai";
import {
  readImageDimensions,
  type LocalPosterImageFile,
} from "@dramabridge/media-assets";

import {
  buildKuaishouCounterpartCoverPrompt,
  buildKuaishouTextlessVariantCoverPrompt,
  KUAISHOU_DRAMA_COVER_SIZE,
  KUAISHOU_EPISODE_COVER_SIZE,
  listKuaishouTextlessVariantKinds,
  prepareKuaishouDramaCoverFiles,
  resolveKuaishouDramaCoverFile,
  resolveKuaishouEpisodeCoverFile,
  selectKuaishouCoverSources,
} from "../../src/shared/cover-materials.js";
import type { KuaishouDramaTaskConfig } from "../../src/shared/types.js";

function poster(
  file: string,
  width: number,
  height: number,
): LocalPosterImageFile {
  return {
    name: path.basename(file),
    file,
    size: 1,
    width,
    height,
  };
}

function svg(width: number, height: number, color: string) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="${color}"/>` +
      `<circle cx="50%" cy="45%" r="20%" fill="#ffffff"/>` +
      `</svg>`,
  );
}

async function generatedCoverFixture(options: {
  retries?: number;
  generate?: (request: ImageGenerationOptions, call: number) => Uint8Array | undefined;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kuaishou-generated-cover-"));
  const landscape = path.join(root, "landscape.svg");
  const portrait = path.join(root, "portrait.svg");
  await Promise.all([
    writeFile(landscape, svg(1_600, 1_000, "#b91c1c")),
    writeFile(portrait, svg(900, 1_200, "#1d4ed8")),
  ]);
  const requests: ImageGenerationOptions[] = [];
  let analysisCalls = 0;
  const aiClient = {
    generateImage: async (request: ImageGenerationOptions) => {
      requests.push(request);
      const [width, height] = request.size!.split("x").map(Number);
      // Intentionally include visible text: content must never block upload preparation.
      const data = options.generate ? options.generate(request, requests.length) : Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<rect width="100%" height="100%" fill="#15803d"/><text x="30" y="80" font-size="60">TITLE 123</text></svg>`,
      );
      return { images: data ? [{ data, mimeType: "image/svg+xml" }] : [], model: "test-image-model" };
    },
    analyzeImages: async () => {
      analysisCalls++;
      throw new Error("Kuaishou covers must not invoke AI content inspection");
    },
  } as unknown as DramaAiClient;
  const runtime = { aiClient, aiImageModel: "test-image-model", aiCoverGenerationRetryAttempts: options.retries ?? 1, assetDownloadDir: root };
  const task = { title: "原剧名", publishType: "广告多版本", adVersionCount: 2,
    adVersionTitles: ["第二版剧名"], summary: "测试剧情" } as KuaishouDramaTaskConfig;
  return { requests, task, analysisCalls: () => analysisCalls,
    run: () => prepareKuaishouDramaCoverFiles(task, [poster(landscape, 1600, 1000), poster(portrait, 900, 1200)], runtime),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

void test("prepares generated covers containing text without any AI content inspection or redraw", async () => {
  const fixture = await generatedCoverFixture();
  try {
    await fixture.run();
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.analysisCalls(), 0);
    assert.deepEqual(await readImageDimensions(resolveKuaishouDramaCoverFile(fixture.task, "ad-unlock-2")), KUAISHOU_DRAMA_COVER_SIZE);
    assert.deepEqual(await readImageDimensions(resolveKuaishouEpisodeCoverFile(fixture.task, "ad-unlock-2")), KUAISHOU_EPISODE_COVER_SIZE);
    await fixture.run();
    assert.equal(fixture.requests.length, 2, "generated files must be reused without a content-verification marker");
    assert.equal(fixture.analysisCalls(), 0);
    for (const file of Object.values(fixture.task.localVariantCoverFiles!["ad-unlock-2"]!)) {
      const metadataFile = path.join(path.dirname(file), "generation.json");
      const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
      assert.equal(metadata.generationComplete, true);
      assert.equal(metadata.validation, undefined);
      // Previously accepted cache entries must also remain reusable after upgrading.
      delete metadata.generationComplete;
      metadata.validation = { passed: true };
      await writeFile(metadataFile, JSON.stringify(metadata));
    }
    await fixture.run();
    assert.equal(fixture.requests.length, 2);
  } finally { await fixture.close(); }
});

void test("still retries a missing image response without calling AI inspection", async () => {
  const fixture = await generatedCoverFixture({ generate: (request, call) => {
    if (call === 1) return undefined;
    const [width, height] = request.size!.split("x").map(Number);
    return svg(width!, height!, "#15803d");
  } });
  try {
    await fixture.run();
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.analysisCalls(), 0);
  } finally { await fixture.close(); }
});

void test("unreadable generated image bytes still fail instead of preparing a broken upload", async () => {
  const fixture = await generatedCoverFixture({ generate: () => Buffer.from("invalid image"), retries: 0 });
  try {
    await assert.rejects(fixture.run(), /KUAISHOU_DRAMA_AI_COVER_GENERATION_FAILED/);
    assert.equal(fixture.task.localVariantCoverFiles?.["ad-unlock-2"], undefined);
    assert.equal(fixture.analysisCalls(), 0);
  } finally { await fixture.close(); }
});

void test("selects existing landscape and portrait sources independently", () => {
  const sources = selectKuaishouCoverSources([
    poster("portrait.jpg", 900, 1_200),
    poster("landscape.jpg", 1_600, 1_000),
  ]);

  assert.equal(sources.landscape?.file, "landscape.jpg");
  assert.equal(sources.portrait?.file, "portrait.jpg");
  assert.equal(sources.fallback?.file, "portrait.jpg");
});

void test("keeps technical dimensions out of model-visible generation prompts", () => {
  const dramaPrompt = buildKuaishouCounterpartCoverPrompt({
    kind: "drama",
    title: "测试短剧",
  });
  const episodePrompt = buildKuaishouCounterpartCoverPrompt({
    kind: "episode",
    title: "测试短剧",
  });

  assert.match(dramaPrompt, /横版/);
  assert.match(episodePrompt, /竖版/);
  assert.match(dramaPrompt, /“测试短剧”/);
  assert.doesNotMatch(dramaPrompt, /414:258|2208x1376/);
  assert.doesNotMatch(episodePrompt, /224:300|1792x2400/);
  assert.match(dramaPrompt, /地点、年代、人物身份/);
  assert.match(dramaPrompt, /画幅比例、分辨率/);
  assert.doesNotMatch(dramaPrompt, /最终成图只能出现一处|除剧名外，严禁/);
});

void test("textless variant prompts require distinct compositions and both orientations", () => {
  const second = buildKuaishouTextlessVariantCoverPrompt({ kind: "drama", variant: 2, summary: "测试剧情" });
  const third = buildKuaishouTextlessVariantCoverPrompt({ kind: "episode", variant: 3, summary: "测试剧情" });
  assert.match(second, /横向构图/);
  assert.match(third, /竖向构图/);
  assert.match(second, /不参考原图的文字、标题或海报排版/);
  assert.match(second, /彻底去掉.*所有剧名/);
  assert.notEqual(second, third);
  assert.doesNotMatch(second, /2208|1376|414:258/);
});

void test("selects only the extra cover variants required by the publish type", () => {
  assert.deepEqual(listKuaishouTextlessVariantKinds("付费"), []);
  assert.deepEqual(listKuaishouTextlessVariantKinds("广告"), []);
  assert.deepEqual(listKuaishouTextlessVariantKinds("三个广告版本"), [
    "ad-unlock-2",
    "ad-unlock-3",
  ]);
  assert.deepEqual(listKuaishouTextlessVariantKinds("五个广告版本"), [
    "ad-unlock-2",
    "ad-unlock-3",
    "ad-unlock-4",
    "ad-unlock-5",
  ]);
  assert.deepEqual(listKuaishouTextlessVariantKinds("六个广告版本"), [
    "ad-unlock-2",
    "ad-unlock-3",
    "ad-unlock-4",
    "ad-unlock-5",
    "ad-unlock-6",
  ]);
  assert.deepEqual(listKuaishouTextlessVariantKinds("八个广告版本"), [
    "ad-unlock-2",
    "ad-unlock-3",
    "ad-unlock-4",
    "ad-unlock-5",
    "ad-unlock-6",
    "ad-unlock-7",
    "ad-unlock-8",
  ]);
  assert.deepEqual(listKuaishouTextlessVariantKinds("全部"), [
    "ad-unlock-2",
    "ad-unlock-3",
    "ad-unlock-4",
    "ad-unlock-5",
    "ad-unlock-6",
    "ad-unlock-7",
    "ad-unlock-8",
  ]);
  assert.equal(listKuaishouTextlessVariantKinds({
    publishType: "广告多版本",
    adVersionCount: 10,
  }).at(-1), "ad-unlock-10");
});

void test("generates only the missing landscape cover and shares prepared files across variants", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kuaishou-cover-test-"));
  try {
    const portraitFile = path.join(temporaryRoot, "portrait.svg");
    await writeFile(portraitFile, svg(900, 1_200, "#1d4ed8"));
    const requests: ImageGenerationOptions[] = [];
    const aiClient = {
      generateImage: async (request: ImageGenerationOptions) => {
        requests.push(request);
        return {
          images: [{
            data: svg(
              KUAISHOU_DRAMA_COVER_SIZE.width,
              KUAISHOU_DRAMA_COVER_SIZE.height,
              "#b91c1c",
            ),
            mimeType: "image/svg+xml",
          }],
          model: request.model ?? "test-image-model",
        };
      },
      analyzeImages: async () => {
        throw new Error("Kuaishou cover content inspection must not run");
      },
    } as unknown as DramaAiClient;
    const task = {
      title: "竖版补横版测试剧",
      publishType: "广告",
    } as unknown as KuaishouDramaTaskConfig;

    const result = await prepareKuaishouDramaCoverFiles(
      task,
      [poster(portraitFile, 900, 1_200)],
      {
        aiClient,
        aiImageModel: "test-image-model",
        assetDownloadDir: temporaryRoot,
      },
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.size, "2208x1376");
    assert.deepEqual(
      await readImageDimensions(result.dramaCover),
      KUAISHOU_DRAMA_COVER_SIZE,
    );
    assert.deepEqual(
      await readImageDimensions(result.episodeCover),
      KUAISHOU_EPISODE_COVER_SIZE,
    );
    assert.equal(resolveKuaishouDramaCoverFile(task), result.dramaCover);
    assert.equal(resolveKuaishouEpisodeCoverFile(task), result.episodeCover);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

void test("does not call AI when both source orientations already exist", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kuaishou-cover-existing-test-"));
  try {
    const landscapeFile = path.join(temporaryRoot, "landscape.svg");
    const portraitFile = path.join(temporaryRoot, "portrait.svg");
    await Promise.all([
      writeFile(landscapeFile, svg(1_600, 1_000, "#b91c1c")),
      writeFile(portraitFile, svg(900, 1_200, "#1d4ed8")),
    ]);
    const task = { title: "双封面测试剧", publishType: "广告" } as unknown as KuaishouDramaTaskConfig;

    const result = await prepareKuaishouDramaCoverFiles(
      task,
      [
        poster(portraitFile, 900, 1_200),
        poster(landscapeFile, 1_600, 1_000),
      ],
      { assetDownloadDir: temporaryRoot },
    );

    assert.deepEqual(await readImageDimensions(result.dramaCover), KUAISHOU_DRAMA_COVER_SIZE);
    assert.deepEqual(await readImageDimensions(result.episodeCover), KUAISHOU_EPISODE_COVER_SIZE);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

void test("generates separate textless landscape and portrait covers for ad versions two through eight", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kuaishou-ad-cover-test-"));
  try {
    const landscapeFile = path.join(temporaryRoot, "landscape.svg");
    const portraitFile = path.join(temporaryRoot, "portrait.svg");
    await Promise.all([
      writeFile(landscapeFile, svg(1_600, 1_000, "#b91c1c")),
      writeFile(portraitFile, svg(900, 1_200, "#1d4ed8")),
    ]);
    const requests: ImageGenerationOptions[] = [];
    const aiClient = {
      generateImage: async (request: ImageGenerationOptions) => {
        requests.push(request);
        const [width, height] = request.size!.split("x").map(Number);
        return { images: [{ data: svg(width!, height!, "#15803d"), mimeType: "image/svg+xml" }], model: "test-image-model" };
      },
      analyzeImages: async () => {
        throw new Error("Kuaishou cover content inspection must not run");
      },
    } as unknown as DramaAiClient;
    const task = {
      title: "原剧名",
      publishType: "全部",
      summary: "测试剧情简介",
      adVersion2Title: "第二版剧名",
      adVersion3Title: "第三版剧名",
      adVersion4Title: "第四版剧名",
      adVersion5Title: "第五版剧名",
      adVersion6Title: "第六版剧名",
      adVersion7Title: "第七版剧名",
      adVersion8Title: "第八版剧名",
    } as unknown as KuaishouDramaTaskConfig;
    const originals = await prepareKuaishouDramaCoverFiles(task, [
      poster(landscapeFile, 1_600, 1_000),
      poster(portraitFile, 900, 1_200),
    ], { aiClient, aiImageModel: "test-image-model", assetDownloadDir: temporaryRoot });
    assert.equal(requests.length, 14);
    assert.equal(resolveKuaishouDramaCoverFile(task, "ad-unlock"), originals.dramaCover);
    assert.equal(resolveKuaishouEpisodeCoverFile(task, "full-paid"), originals.episodeCover);
    for (const kind of ["ad-unlock-2", "ad-unlock-3", "ad-unlock-4", "ad-unlock-5", "ad-unlock-6", "ad-unlock-7", "ad-unlock-8"]) {
      assert.deepEqual(await readImageDimensions(resolveKuaishouDramaCoverFile(task, kind)), KUAISHOU_DRAMA_COVER_SIZE);
      assert.deepEqual(await readImageDimensions(resolveKuaishouEpisodeCoverFile(task, kind)), KUAISHOU_EPISODE_COVER_SIZE);
      assert.notEqual(resolveKuaishouDramaCoverFile(task, kind), originals.dramaCover);
      assert.notEqual(resolveKuaishouEpisodeCoverFile(task, kind), originals.episodeCover);
    }
    assert.equal(new Set([
      "ad-unlock-2",
      "ad-unlock-3",
      "ad-unlock-4",
      "ad-unlock-5",
      "ad-unlock-6",
      "ad-unlock-7",
      "ad-unlock-8",
    ].map((kind) => resolveKuaishouDramaCoverFile(task, kind))).size, 7);
    assert.deepEqual(requests.map((request) => request.size).sort(), [
      "1792x2400", "1792x2400", "1792x2400", "1792x2400", "1792x2400", "1792x2400", "1792x2400",
      "2208x1376", "2208x1376", "2208x1376", "2208x1376", "2208x1376", "2208x1376", "2208x1376",
    ]);
    assert.ok(requests.every((request) => String(request.prompt).includes("不要绘制任何新文字")));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
