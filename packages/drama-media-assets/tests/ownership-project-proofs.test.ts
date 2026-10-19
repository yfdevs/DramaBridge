import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { DramaAiClient } from "@drama/ai";
import sharp from "sharp";

import {
  classifyOwnershipProjectProof,
  classifyOwnershipProjectProofName,
  findOwnershipProjectProofFiles,
  hasRequiredOwnershipMaterials,
  selectOwnershipProjectProofFiles,
  standardizeOwnershipMaterialsToRoot,
  type ClassifiedOwnershipProjectProof,
} from "../src/index.js";

const liveOwnershipProofDirectory =
  "D:\\BaiduNetdiskDownload\\装够了，本宫天下无敌\\权属文件";

function cloudAiClassifier(kind: "jianying" | "juchuang" | "unknown"): DramaAiClient {
  return {
    analyzeImages: async (options) => {
      assert.ok(options.images.length === 3 || options.images.length === 4);
      assert.match(options.prompt, /Guagu Studio/u);
      if (options.images.length === 4) {
        assert.match(options.prompt, /只回答两个独立的布尔判断/u);
        assert.match(options.prompt, /单张海报、人物头像/u);
      }
      for (const image of options.images) {
        assert.equal(image.type, "data-url");
        if (image.type === "data-url") {
          assert.match(image.dataUrl, /^data:image\/jpeg;base64,/u);
        }
      }
      return {
        finishReason: "stop",
        model: "test-vision-model",
        text: JSON.stringify({
          isEngineeringScreenshot: kind !== "unknown",
          jianyingLabelVisible: kind === "jianying",
          evidence: "test",
        }),
      };
    },
    generateImage: async () => { throw new Error("not used"); },
    generateText: async () => { throw new Error("not used"); },
  };
}

function proof(index: number, kind: ClassifiedOwnershipProjectProof["kind"]) {
  return {
    kind,
    material: {
      index,
      name: `测试剧 - 权属工程文件${index}.png`,
      file: `D:\\素材\\测试剧 - 权属工程文件${index}.png`,
      size: 1000 + index,
    },
  } satisfies ClassifiedOwnershipProjectProof;
}

test("prefers explicit proof source names", () => {
  assert.equal(classifyOwnershipProjectProofName("剪映1.png"), "jianying");
  assert.equal(classifyOwnershipProjectProofName("Jianying 2.PNG"), "jianying");
  assert.equal(classifyOwnershipProjectProofName("CapCut-3.jpg"), "jianying");
  assert.equal(classifyOwnershipProjectProofName("剧创1.png"), "juchuang");
  assert.equal(classifyOwnershipProjectProofName("即梦 2.png"), "juchuang");
  assert.equal(classifyOwnershipProjectProofName("jimeng-3.webp"), "juchuang");
  assert.equal(classifyOwnershipProjectProofName("Seedance 2.0 工程截图.png"), "juchuang");
  assert.equal(classifyOwnershipProjectProofName("seedream-workspace.webp"), "juchuang");
  assert.equal(classifyOwnershipProjectProofName("剪映和剧创/工程1.png"), undefined);
  assert.equal(classifyOwnershipProjectProofName("测试剧 - 权属工程文件1.png"), undefined);
});

test("rechecks unknown screenshots using the platform label and right-side prompt panel", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-guagu-recheck-"));
  const file = path.join(root, "权属工程文件2.png");
  let calls = 0;
  const aiClient: DramaAiClient = {
    analyzeImages: async (options) => {
      calls += 1;
      assert.equal(options.images.length, calls === 1 ? 4 : 3);
      assert.match(options.prompt, /Guagu Studio/u);
      return {
        finishReason: "stop",
        model: "test-vision-model",
        text: JSON.stringify({
          isEngineeringScreenshot: calls !== 1,
          jianyingLabelVisible: false,
          evidence: calls === 1 ? "small label" : "Guagu Studio with input prompt",
        }),
      };
    },
    generateImage: async () => { throw new Error("not used"); },
    generateText: async () => { throw new Error("not used"); },
  };
  try {
    await sharp({
      create: { width: 2_048, height: 1_080, channels: 3, background: "#f2f2f2" },
    }).png().toFile(file);
    assert.equal(await classifyOwnershipProjectProof(file, path.basename(file), aiClient), "juchuang");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies explicitly named parent directories without opening the image", async () => {
  assert.equal(
    await classifyOwnershipProjectProof("D:\\素材\\权属文件\\剪映\\工程1.png", "工程1.png"),
    "jianying",
  );
  assert.equal(
    await classifyOwnershipProjectProof("D:\\素材\\权属文件\\剧创\\工程1.png", "工程1.png"),
    "juchuang",
  );
});

test("does not treat unrelated cached images as sufficient Jianying proofs", () => {
  const materials = [
    ...Array.from({ length: 8 }, (_, index) => ({
      file: `D:\\素材\\角色头像\\头像${index + 1}.png`,
      name: `头像${index + 1}.png`,
      size: 100,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      file: `D:\\素材\\剧创工程图\\工程${index + 1}.png`,
      name: `工程${index + 1}.png`,
      size: 100,
    })),
  ];

  assert.equal(
    hasRequiredOwnershipMaterials(materials, {
      minimumImages: 4,
      minimumJianyingImages: 4,
    }),
    false,
  );
  assert.equal(
    hasRequiredOwnershipMaterials([
      ...materials,
      ...Array.from({ length: 4 }, (_, index) => ({
        file: `D:\\素材\\剪映工程图\\截图\\工程${index + 1}.jpg`,
        name: `工程${index + 1}.jpg`,
        size: 100,
      })),
    ], {
      minimumImages: 4,
      minimumJianyingImages: 4,
    }),
    true,
  );
});

test("preserves Baidu filename labels while standardizing and skips cloud AI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-name-preservation-"));
  const sourceDir = path.join(root, "download", "权属");
  const targetRoot = path.join(root, "materials");
  const resourceName = "测试剧";
  await mkdir(sourceDir, { recursive: true });
  const sourceNames = ["剪映.png", "剪映1.png", "剧创.png", "剧创1.png"];

  try {
    const sourceFiles = await Promise.all(sourceNames.map(async (name, index) => {
      const file = path.join(sourceDir, name);
      await sharp({
        create: { width: 1_920, height: 1_080, channels: 3, background: `rgb(${index},0,0)` },
      }).png().toFile(file);
      return { name, file, size: (await stat(file)).size };
    }));
    const standardized = await standardizeOwnershipMaterialsToRoot({
      materials: sourceFiles,
      requirements: { minimumImages: 4 },
      targetRoot,
      resourceName,
    });

    assert.deepEqual(standardized.map((file) => file.name), [
      "测试剧 - 剪映1.png",
      "测试剧 - 剪映2.png",
      "测试剧 - 剧创1.png",
      "测试剧 - 剧创2.png",
    ]);
    const selection = await findOwnershipProjectProofFiles({ root: targetRoot, resourceName });
    assert.equal(selection.jianying.length, 2);
    assert.equal(selection.juchuang.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a Jianying label from a nested source directory while standardizing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-nested-directory-label-"));
  const sourceDir = path.join(root, "download", "权属文件", "剪映工程图", "截图");
  const targetRoot = path.join(root, "materials");
  const resourceName = "亡妻归来，替身入局";
  await mkdir(sourceDir, { recursive: true });

  try {
    const sourceFiles = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const name = `工程文件${index + 1}.png`;
      const file = path.join(sourceDir, name);
      await sharp({
        create: { width: 1_920, height: 1_080, channels: 3, background: `rgb(${index},0,0)` },
      }).png().toFile(file);
      return { name, file, size: (await stat(file)).size };
    }));
    const standardized = await standardizeOwnershipMaterialsToRoot({
      materials: sourceFiles,
      requirements: { minimumImages: 4 },
      targetRoot,
      resourceName,
    });

    assert.deepEqual(standardized.map((file) => file.name), [
      `${resourceName} - 剪映1.png`,
      `${resourceName} - 剪映2.png`,
      `${resourceName} - 剪映3.png`,
      `${resourceName} - 剪映4.png`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses cloud AI for valid screenshots and rejects non-screenshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-project-proof-"));
  try {
    const darkScreenshot = path.join(root, "工程1.png");
    const lightScreenshot = path.join(root, "工程2.png");
    const portraitLikeImage = path.join(root, "工程3.png");
    await Promise.all([
      sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#303438" } })
        .png()
        .toFile(darkScreenshot),
      sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#f2f2f2" } })
        .png()
        .toFile(lightScreenshot),
      sharp({ create: { width: 1200, height: 1000, channels: 3, background: "#303438" } })
        .png()
        .toFile(portraitLikeImage),
    ]);

    assert.equal(
      await classifyOwnershipProjectProof(darkScreenshot, undefined, cloudAiClassifier("jianying")),
      "jianying",
    );
    assert.equal(
      await classifyOwnershipProjectProof(lightScreenshot, undefined, cloudAiClassifier("juchuang")),
      "juchuang",
    );
    assert.equal(
      await classifyOwnershipProjectProof(portraitLikeImage, undefined, cloudAiClassifier("unknown")),
      "unknown",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "sends live ownership screenshots to the cloud AI classifier after removing filename hints",
  { skip: !existsSync(liveOwnershipProofDirectory) },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ownership-project-proof-live-"));
    const fixtures = [
      ...Array.from({ length: 10 }, (_, index) => ({
        expected: "jianying" as const,
        source: path.join(liveOwnershipProofDirectory, `剪映${index + 1}.png`),
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        expected: "juchuang" as const,
        source: path.join(liveOwnershipProofDirectory, `剧创${index + 1}.png`),
      })),
    ];

    try {
      for (const [index, fixture] of fixtures.entries()) {
        const neutralFile = path.join(root, `截图-${index + 1}.png`);
        await copyFile(fixture.source, neutralFile);
        assert.equal(
          await classifyOwnershipProjectProof(
            neutralFile,
            path.basename(neutralFile),
            cloudAiClassifier(fixture.expected),
          ),
          fixture.expected,
          fixture.source,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("selects the first two numbered screenshots from each proof source", () => {
  const selection = selectOwnershipProjectProofFiles([
    proof(10, "jianying"),
    proof(4, "juchuang"),
    proof(3, "jianying"),
    proof(2, "juchuang"),
    proof(1, "jianying"),
    proof(8, "juchuang"),
  ]);

  assert.deepEqual(selection.jianying.map((item) => item.index), [1, 3]);
  assert.deepEqual(selection.juchuang.map((item) => item.index), [2, 4]);
  assert.deepEqual(selection.files, [
    "D:\\素材\\测试剧 - 权属工程文件1.png",
    "D:\\素材\\测试剧 - 权属工程文件3.png",
    "D:\\素材\\测试剧 - 权属工程文件2.png",
    "D:\\素材\\测试剧 - 权属工程文件4.png",
  ]);
});

test("selects four original screenshots from each proof source when requested", () => {
  const selection = selectOwnershipProjectProofFiles([
    ...Array.from({ length: 5 }, (_, index) => proof(index + 1, "jianying")),
    ...Array.from({ length: 5 }, (_, index) => proof(index + 6, "juchuang")),
  ], 4);

  assert.deepEqual(selection.jianying.map((item) => item.index), [1, 2, 3, 4]);
  assert.deepEqual(selection.juchuang.map((item) => item.index), [6, 7, 8, 9]);
  assert.equal(selection.files.length, 8);
  assert.ok(selection.files.every((file) => /权属工程文件\d+\.png$/u.test(file)));
});

test("requires four classified screenshots from both sources", () => {
  assert.throws(
    () => selectOwnershipProjectProofFiles([
      ...Array.from({ length: 4 }, (_, index) => proof(index + 1, "jianying")),
      ...Array.from({ length: 3 }, (_, index) => proof(index + 5, "juchuang")),
    ], 4),
    /剪映=4\/4，剧创=3\/4/u,
  );
});

test("supports different required counts for 剪映 and 剧创", () => {
  const classified = [
    ...Array.from({ length: 3 }, (_, index) => proof(index + 1, "jianying")),
    ...Array.from({ length: 4 }, (_, index) => proof(index + 4, "juchuang")),
  ];
  const selection = selectOwnershipProjectProofFiles(classified, { jianying: 2, juchuang: 3 });
  assert.deepEqual(selection.jianying.map((item) => item.index), [1, 2]);
  assert.deepEqual(selection.juchuang.map((item) => item.index), [4, 5, 6]);
  assert.throws(
    () => selectOwnershipProjectProofFiles(classified, { jianying: 4, juchuang: 3 }),
    /剪映=3\/4，剧创=4\/3/u,
  );
});

test("stops classifying screenshots after both required proof sources are satisfied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-project-proof-early-stop-"));
  const resourceName = "测试剧";
  const ownershipDir = path.join(root, resourceName, "权属文件");
  const jianyingDir = path.join(ownershipDir, "剪映");
  const juchuangDir = path.join(ownershipDir, "剧创");
  await Promise.all([
    mkdir(jianyingDir, { recursive: true }),
    mkdir(juchuangDir, { recursive: true }),
  ]);
  const fixtures = [
    { directory: jianyingDir, index: 1 },
    { directory: juchuangDir, index: 2 },
    { directory: jianyingDir, index: 3 },
    { directory: juchuangDir, index: 4 },
    { directory: ownershipDir, index: 5 },
  ];

  try {
    await Promise.all(fixtures.map(({ directory, index }) =>
      sharp({
        create: {
          width: 1_920,
          height: 1_080,
          channels: 3,
          background: { r: index * 20, g: index * 20, b: index * 20 },
        },
      }).png().toFile(path.join(directory, `${resourceName} - 权属工程文件${index}.png`))
    ));
    const progress: number[] = [];
    const selection = await findOwnershipProjectProofFiles({
      root,
      resourceName,
      onClassificationProgress: ({ completed }) => progress.push(completed),
    });

    assert.deepEqual(progress, [1, 2, 3, 4]);
    assert.deepEqual(selection.jianying.map((item) => item.index), [1, 3]);
    assert.deepEqual(selection.juchuang.map((item) => item.index), [2, 4]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds AI creation workspace proofs beside a generic engineering directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-separate-ai-records-"));
  const resourceName = "计量台上见人心";
  const resourceDir = path.join(root, resourceName);
  const engineeringDir = path.join(resourceDir, "工程文件");
  const aiRecordsDir = path.join(resourceDir, "AI生成记录");
  await Promise.all([
    mkdir(engineeringDir, { recursive: true }),
    mkdir(aiRecordsDir, { recursive: true }),
  ]);
  const fixtures = [
    ...Array.from({ length: 10 }, (_, index) => ({ dir: engineeringDir, name: `${index + 1}.png` })),
    ...["alpha.png", "beta.png", "gamma.png", "delta.png"].map((name) => ({ dir: aiRecordsDir, name })),
  ];
  let calls = 0;
  const aiClient: DramaAiClient = {
    analyzeImages: async (options) => {
      assert.match(options.prompt, /LiblibTV/u);
      return {
        finishReason: "stop",
        model: "test-vision-model",
        text: JSON.stringify({ kind: calls++ < 2 ? "jianying" : "juchuang", evidence: "test" }),
      };
    },
    generateImage: async () => { throw new Error("not used"); },
    generateText: async () => { throw new Error("not used"); },
  };

  try {
    await Promise.all(fixtures.map(({ dir, name }, index) =>
      sharp({
        create: {
          width: 1_920,
          height: 1_080,
          channels: 3,
          background: { r: 25 + index * 15, g: 40, b: 60 },
        },
      }).png().toFile(path.join(dir, name))
    ));
    const selection = await findOwnershipProjectProofFiles({ root, resourceName, aiClient });
    assert.equal(calls, 4);
    assert.equal(selection.jianying.length, 2);
    assert.equal(selection.juchuang.length, 2);
    assert.ok(selection.jianying.every((item) => path.dirname(item.file) === engineeringDir));
    assert.ok(
      selection.juchuang.every((item) => path.dirname(item.file) === aiRecordsDir),
      selection.juchuang.map((item) => item.file).join(", "),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reclassifies misleading mixed-directory names from image content when one kind is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-project-proof-fallback-"));
  const resourceName = "混合目录测试剧";
  const misleadingDir = path.join(root, resourceName, "权属文件", "剪映");
  await mkdir(misleadingDir, { recursive: true });
  const kinds = ["jianying", "jianying", "juchuang", "juchuang"] as const;
  let calls = 0;
  const aiClient: DramaAiClient = {
    analyzeImages: async () => ({
      finishReason: "stop",
      model: "test-vision-model",
      text: JSON.stringify({ kind: kinds[calls++] ?? "unknown", evidence: "test" }),
    }),
    generateImage: async () => { throw new Error("not used"); },
    generateText: async () => { throw new Error("not used"); },
  };

  try {
    await Promise.all(kinds.map((_kind, index) =>
      sharp({
        create: {
          width: 1_920,
          height: 1_080,
          channels: 3,
          background: { r: 30 + index * 20, g: 30, b: 30 },
        },
      }).png().toFile(path.join(misleadingDir, `${resourceName} - 权属工程文件${index + 1}.png`))
    ));

    const selection = await findOwnershipProjectProofFiles({ root, resourceName, aiClient });
    assert.equal(calls, 4);
    assert.equal(selection.jianying.length, 2);
    assert.equal(selection.juchuang.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails before platform automation when either proof source has fewer than two images", () => {
  assert.throws(
    () => selectOwnershipProjectProofFiles([
      proof(1, "jianying"),
      proof(2, "juchuang"),
      proof(4, "juchuang"),
    ]),
    /剪映=1\/2，剧创=2\/2/u,
  );
});

test("reports unrecognized images instead of treating them as 剧创", () => {
  assert.throws(
    () => selectOwnershipProjectProofFiles([
      proof(1, "jianying"),
      proof(2, "juchuang"),
      proof(3, "unknown"),
    ]),
    /剪映=1\/2，剧创=1\/2，未识别=1.*权属工程文件3\.png/u,
  );
});
