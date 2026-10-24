import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  getWechatOwnershipProofCounts,
  getWechatOwnershipRequirements,
  loadWechatOwnershipMaterials,
  prepareWechatProductionProofMaterials,
} from "../../src/shared/production-proof-materials.js";
import { configureWechatVideoRuntimeSettings } from "../../src/shared/runtime-settings.js";
import type { Config } from "../../src/shared/types.js";

function image(red: number) {
  return sharp({
    create: {
      width: 64,
      height: 32,
      channels: 3,
      background: { r: red, g: 40, b: 20 },
    },
  }).png().toBuffer();
}

test("defaults to four images of each ownership proof kind", () => {
  configureWechatVideoRuntimeSettings();
  assert.deepEqual(getWechatOwnershipProofCounts(), { jianying: 4, juchuang: 4 });
  assert.deepEqual(getWechatOwnershipRequirements(), { minimumImages: 8 });
});

test("preserves four explicitly named Jianying proofs even when cloud AI would classify all eight as Juchuang", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wechat-named-production-proof-"));
  const resourceName = "新郎等婚车，我却叫来了搬家车";
  const ownershipDir = path.join(root, resourceName, "权属文件");
  await mkdir(ownershipDir, { recursive: true });
  const names = ["剪映1.png", "剪映2.png", "剪映3.png", "剪映4.png", "剧创1.png", "剧创2.png", "剧创3.png", "剧创4.png"];
  let aiCalls = 0;
  const aiClient: NonNullable<Parameters<typeof prepareWechatProductionProofMaterials>[1]> = {
    analyzeImages: async () => {
      aiCalls++;
      return { finishReason: "stop", model: "test-vision-model", text: JSON.stringify({
        isEngineeringScreenshot: true, jianyingLabelVisible: false,
      }) };
    },
    generateImage: async () => { throw new Error("not used"); },
    generateText: async () => { throw new Error("not used"); },
  };
  try {
    await Promise.all(names.map(async (name, index) => writeFile(path.join(ownershipDir, name), await image(index + 80))));
    configureWechatVideoRuntimeSettings({ localEpisodeVideoRoot: root });
    const config = { originalTitle: resourceName, playlet: { name: resourceName, copyright: {} } } as Config;
    const sources: string[] = [];
    const files = await prepareWechatProductionProofMaterials(config, aiClient, progress => sources.push(progress.source!));
    assert.equal(aiCalls, 0);
    assert.equal(files.length, 8);
    assert.equal(files.filter(file => path.basename(file).startsWith("剪映")).length, 4);
    assert.equal(files.filter(file => path.basename(file).startsWith("剧创")).length, 4);
    assert.ok(sources.every(source => source === "name"));
    // Clearly named files also work when no classifier is available.
    assert.deepEqual(await prepareWechatProductionProofMaterials(config), files);
  } finally {
    configureWechatVideoRuntimeSettings();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses named nested directories and sends only ambiguous filenames to AI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wechat-mixed-production-proof-"));
  const resourceName = "混合命名权属测试剧";
  const namedDir = path.join(root, resourceName, "权属文件", "剪映工程图", "截图");
  const unknownDir = path.join(root, resourceName, "权属文件", "制作记录");
  await Promise.all([mkdir(namedDir, { recursive: true }), mkdir(unknownDir, { recursive: true })]);
  let aiCalls = 0;
  const aiClient: NonNullable<Parameters<typeof prepareWechatProductionProofMaterials>[1]> = {
    analyzeImages: async () => {
      aiCalls++;
      return { finishReason: "stop", model: "test-vision-model", text: JSON.stringify({ kind: "juchuang" }) };
    },
    generateImage: async () => { throw new Error("not used"); },
    generateText: async () => { throw new Error("not used"); },
  };
  try {
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await writeFile(path.join(index < 4 ? namedDir : unknownDir, `工程${index + 1}.png`), await image(index + 100));
    }));
    configureWechatVideoRuntimeSettings({ localEpisodeVideoRoot: root });
    const config = { originalTitle: resourceName, playlet: { name: resourceName, copyright: {} } } as Config;
    const files = await prepareWechatProductionProofMaterials(config, aiClient);
    assert.equal(aiCalls, 4);
    assert.equal(files.filter(file => file.startsWith(namedDir)).length, 4);
    assert.equal(files.filter(file => file.startsWith(unknownDir)).length, 4);
  } finally {
    configureWechatVideoRuntimeSettings();
    await rm(root, { recursive: true, force: true });
  }
});

test("uploads four AI-classified images of each kind without contracts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wechat-production-proof-"));
  const resourceName = "权属规则测试剧";
  const ownershipDir = path.join(root, resourceName, "权属文件");
  await mkdir(ownershipDir, { recursive: true });
  const ownership = Array.from({ length: 8 }, (_, index) =>
    path.join(ownershipDir, `工程${index + 1}.png`));

  try {
    await Promise.all(ownership.map(async (file, index) => writeFile(file, await image(index + 20))));
    configureWechatVideoRuntimeSettings({ localEpisodeVideoRoot: root });
    const config = {
      originalTitle: resourceName,
      playlet: {
        name: resourceName,
        copyright: { productionProofFiles: ["https://example.com/ignored-contract.png"] },
      },
    } as Config;
    const available = await loadWechatOwnershipMaterials(config);
    assert.equal(available.length, 8);

    let aiCalls = 0;
    const aiClient: Parameters<typeof prepareWechatProductionProofMaterials>[1] = {
      analyzeImages: async () => ({
        finishReason: "stop",
        model: "test-vision-model",
        text: JSON.stringify({ kind: ++aiCalls <= 4 ? "jianying" : "juchuang" }),
      }),
      generateImage: async () => { throw new Error("not used"); },
      generateText: async () => { throw new Error("not used"); },
    };
    const files = await prepareWechatProductionProofMaterials(config, aiClient);

    assert.equal(aiCalls, 8);
    assert.deepEqual(files, ownership);
    assert.deepEqual(config.playlet.copyright.productionProofFiles, files);
    assert.ok(files.every((file) => !file.includes("权属工程文件合成")));
  } finally {
    configureWechatVideoRuntimeSettings();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses separate configured counts for download validation and AI upload selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wechat-configured-proof-"));
  const resourceName = "自定义权属数量测试剧";
  const ownershipDir = path.join(root, resourceName, "权属文件");
  await mkdir(ownershipDir, { recursive: true });
  const ownership = Array.from({ length: 5 }, (_, index) =>
    path.join(ownershipDir, `工程${index + 1}.png`));

  try {
    await Promise.all(ownership.map(async (file, index) => writeFile(file, await image(index + 30))));
    configureWechatVideoRuntimeSettings({
      localEpisodeVideoRoot: root,
      jianyingOwnershipProofCount: "2",
      juchuangOwnershipProofCount: "3",
    });
    assert.deepEqual(getWechatOwnershipProofCounts(), { jianying: 2, juchuang: 3 });
    assert.deepEqual(getWechatOwnershipRequirements(), { minimumImages: 5 });

    const config = {
      originalTitle: resourceName,
      playlet: { name: resourceName, copyright: {} },
    } as Config;
    assert.equal((await loadWechatOwnershipMaterials(config)).length, 5);
    let aiCalls = 0;
    const aiClient: Parameters<typeof prepareWechatProductionProofMaterials>[1] = {
      analyzeImages: async () => ({
        finishReason: "stop",
        model: "test-vision-model",
        text: JSON.stringify({ kind: ++aiCalls <= 2 ? "jianying" : "juchuang" }),
      }),
      generateImage: async () => { throw new Error("not used"); },
      generateText: async () => { throw new Error("not used"); },
    };

    assert.deepEqual(await prepareWechatProductionProofMaterials(config, aiClient), ownership);
    assert.equal(aiCalls, 5);
  } finally {
    configureWechatVideoRuntimeSettings();
    await rm(root, { recursive: true, force: true });
  }
});
