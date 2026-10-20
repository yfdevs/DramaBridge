import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  prepareDouyinRolePhoto,
  selectDouyinCoverSources,
  selectDouyinJianyingProjectScreenshots,
} from "../../src/shared/resources.js";

test("expands a highly compressible role portrait beyond Douyin's 50 KiB minimum", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "douyin-role-photo-"));
  try {
    const source = path.join(directory, "tiny-source.png");
    const output = path.join(directory, "prepared.jpg");
    await writeFile(
      source,
      await sharp({
        create: {
          width: 128,
          height: 128,
          channels: 3,
          background: "#e8ddd0",
        },
      }).png().toBuffer(),
    );

    const prepared = await prepareDouyinRolePhoto(source, output);
    const preparedStat = await stat(prepared.file);
    const metadata = await sharp(await readFile(prepared.file)).metadata();
    assert.ok(preparedStat.size >= 50 * 1024, `actual=${preparedStat.size}`);
    assert.ok(preparedStat.size <= 4_700_000, `actual=${preparedStat.size}`);
    assert.equal(metadata.width, 1_024);
    assert.equal(metadata.height, 1_024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses distinct closest-ratio covers when netdisk provides two images", () => {
  const hongguo = { file: "hongguo.jpg", width: 700, height: 1_000 };
  const douyin = { file: "douyin.jpg", width: 720, height: 1_080 };
  const selected = selectDouyinCoverSources([douyin, hongguo]);

  assert.equal(selected.hongguo.file, "hongguo.jpg");
  assert.equal(selected.douyin.file, "douyin.jpg");
});

test("reuses a single cover source for both required output sizes", () => {
  const source = { file: "cover.png", width: 1_024, height: 1_536 };
  const selected = selectDouyinCoverSources([source]);

  assert.equal(selected.hongguo, source);
  assert.equal(selected.douyin, source);
});

test("rejects a resource folder without any cover", () => {
  assert.throws(() => selectDouyinCoverSources([]), /poster-material-invalid/);
});

test("selects exactly four Jianying screenshots and excludes other ownership images", async () => {
  const materials = [
    ...Array.from({ length: 5 }, (_, index) => ({
      file: `D:\\素材\\权属文件\\测试剧 - 剪映${index + 1}.png`,
      index: index + 1,
      name: `测试剧 - 剪映${index + 1}.png`,
      size: 100 + index,
    })),
    {
      file: "D:\\素材\\权属文件\\测试剧 - 剧创1.png",
      index: 1,
      name: "测试剧 - 剧创1.png",
      size: 200,
    },
    {
      file: "D:\\素材\\海报封面\\测试剧 - 海报.jpg",
      name: "测试剧 - 海报.jpg",
      size: 300,
    },
  ];

  assert.deepEqual(await selectDouyinJianyingProjectScreenshots(materials), [
    "D:\\素材\\权属文件\\测试剧 - 剪映1.png",
    "D:\\素材\\权属文件\\测试剧 - 剪映2.png",
    "D:\\素材\\权属文件\\测试剧 - 剪映3.png",
    "D:\\素材\\权属文件\\测试剧 - 剪映4.png",
  ]);
});

test("recognizes Jianying screenshots from the netdisk directory name", async () => {
  const materials = Array.from({ length: 5 }, (_, index) => ({
    file: `D:\\素材\\权属文件\\剪映\\工程截图${index + 1}.png`,
    index: index + 1,
    name: `工程截图${index + 1}.png`,
    size: 100 + index,
  }));

  assert.deepEqual(await selectDouyinJianyingProjectScreenshots(materials), [
    "D:\\素材\\权属文件\\剪映\\工程截图1.png",
    "D:\\素材\\权属文件\\剪映\\工程截图2.png",
    "D:\\素材\\权属文件\\剪映\\工程截图3.png",
    "D:\\素材\\权属文件\\剪映\\工程截图4.png",
  ]);
});

test("recognizes Jianying screenshots when the label is on an ancestor directory", async () => {
  const materials = Array.from({ length: 4 }, (_, index) => ({
    file: `D:\\素材\\权属文件\\剪映工程图\\截图\\工程文件${index + 1}.png`,
    index: index + 1,
    name: `工程文件${index + 1}.png`,
    size: 100 + index,
  }));

  assert.deepEqual(await selectDouyinJianyingProjectScreenshots(materials), materials.map(({ file }) => file));
});

test("uses content classification after netdisk standardization removes source labels", async () => {
  const materials = Array.from({ length: 8 }, (_, index) => ({
    file: `D:\\素材\\权属文件\\测试剧 - 权属工程文件${index + 1}.png`,
    index: index + 1,
    name: `测试剧 - 权属工程文件${index + 1}.png`,
    size: 100 + index,
  }));
  const selected = await selectDouyinJianyingProjectScreenshots(
    materials,
    4,
    async (material) => (material.index! <= 4 ? "juchuang" : "jianying"),
  );
  assert.deepEqual(selected, materials.slice(4).map((material) => material.file));
});

test("uses content classification for a directory labeled with both Jianying and Juchuang", async () => {
  const materials = Array.from({ length: 8 }, (_, index) => ({
    file: `D:\\素材\\5.权属文件截图【剪映截图+剧创截图】\\工程截图${index + 1}.png`,
    index: index + 1,
    name: `工程截图${index + 1}.png`,
    size: 100 + index,
  }));
  let classificationCalls = 0;
  const selected = await selectDouyinJianyingProjectScreenshots(
    materials,
    4,
    async (material) => {
      classificationCalls += 1;
      return material.index! <= 4 ? "juchuang" : "jianying";
    },
  );

  assert.equal(classificationCalls, 8);
  assert.deepEqual(selected, materials.slice(4).map((material) => material.file));
});

test("rejects fewer than four Jianying screenshots", async () => {
  await assert.rejects(
    selectDouyinJianyingProjectScreenshots([
      { file: "D:\\素材\\剪映1.png", index: 1, name: "剪映1.png", size: 100 },
      { file: "D:\\素材\\剪映2.png", index: 2, name: "剪映2.png", size: 100 },
      { file: "D:\\素材\\剧创1.png", index: 1, name: "剧创1.png", size: 100 },
    ]),
    /DOUYIN_DRAMA_JIANYING_SCREENSHOTS_REQUIRED.*实际=2/,
  );
});
