import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { findWeiboOwnershipFiles, prepareWeiboMaterials } from "../../src/shared/materials.js";
import { claimedWeiboDramaTaskSchema } from "../../src/shared/types.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "weibo-proof-"));
  const resourceName = "测试短剧";
  const sharp = createRequire(import.meta.resolve("@dramabridge/media-assets/package.json"))(
    "sharp",
  );
  const image: Buffer = await sharp({
    create: { width: 600, height: 800, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const resource = path.join(root, resourceName);
  await mkdir(path.join(resource, "封面"), { recursive: true });
  await writeFile(path.join(resource, "封面", "海报.png"), image);
  const task = claimedWeiboDramaTaskSchema.parse({
    accountTaskId: 7,
    originalTitle: resourceName,
    playlet: {
      title: resourceName,
      summary: "简介",
      episodeCount: 5,
      collectionCategory: "AI动漫类",
      audienceType: "男频",
      subjectTypes: ["都市"],
      eraBackground: "现代",
      plotThemes: ["逆袭"],
      roleSettings: ["大男主"],
    },
  });
  return {
    root,
    resourceName,
    resource,
    image,
    task,
    options: { localEpisodeVideoRoot: root, assetDownloadDir: path.join(root, "prepared") },
  };
}

test("both Jianying and Juchuang proofs are selected ahead of the poster, capped at five", async () => {
  const f = await fixture();
  for (let index = 0; index < 7; index++) {
    const dir = path.join(f.resource, "权属文件", index === 6 ? "剧创" : "剪映", "截图");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${index}.png`),
      Buffer.concat([f.image, Buffer.from(String(index))]),
    );
  }
  const selected = await findWeiboOwnershipFiles(f, f.options);
  assert.equal(selected.length, 5);
  assert.ok(selected.some((file) => file.includes("剧创")));
  assert.ok(selected.some((file) => file.includes("剪映")));
  await prepareWeiboMaterials(f.task, f.options);
  assert.equal(f.task.playlet.ownershipFiles.length, 5);
  assert.ok(f.task.playlet.ownershipFiles.every((file) => file !== f.task.playlet.localCoverFile));
});

test("only a confirmed empty ownership set uses one cover, and PDF proofs are retained", async () => {
  const f = await fixture();
  await prepareWeiboMaterials(f.task, f.options);
  assert.deepEqual(f.task.playlet.ownershipFiles, [f.task.playlet.localCoverFile]);
  const dir = path.join(f.resource, "权属文件");
  await mkdir(dir);
  const pdf = path.join(dir, "授权证明.pdf");
  await writeFile(pdf, "%PDF-1.7\nfixture");
  await prepareWeiboMaterials(f.task, f.options);
  assert.deepEqual(f.task.playlet.ownershipFiles, [pdf]);
  await writeFile(pdf, "invalid pdf");
  await assert.rejects(prepareWeiboMaterials(f.task, f.options), /OWNERSHIP_FILE_INVALID/);
});

test("unidentified screenshots require recognition instead of silently using a cover", async () => {
  const f = await fixture();
  const dir = path.join(f.resource, "截图");
  await mkdir(dir);
  await writeFile(path.join(dir, "1.png"), f.image);
  await writeFile(path.join(dir, "2.png"), Buffer.concat([f.image, Buffer.from("2")]));
  await assert.rejects(prepareWeiboMaterials(f.task, f.options), /OWNERSHIP_RECOGNITION_FAILED/);
});
