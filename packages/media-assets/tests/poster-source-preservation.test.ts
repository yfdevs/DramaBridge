import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  dramaPosterOriginalImageDirectoryName,
  dramaPosterSourceManifestFileName,
  dramaPosterTextDirectoryName,
  standardizePosterImagesToRoot,
} from "../src/index.js";

test("preserves original actor image names and TXT while standardizing covers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "poster-preservation-"));
  const sourceDir = path.join(root, "raw", "封面和角色");
  const cover = path.join(sourceDir, "封面7比10.jpg");
  const actor = path.join(sourceDir, "刘晓-人物头像.png");
  const text = path.join(sourceDir, "剧情角色介绍.txt");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(cover, "cover-bytes");
  await writeFile(actor, "actor-bytes");
  await writeFile(text, "刘晓：货车司机。", "utf8");

  try {
    await standardizePosterImagesToRoot({
      files: [{ name: path.basename(cover), file: cover, size: 11, width: 700, height: 1_000 }],
      targetRoot: root,
      resourceName: "测试剧",
    });
    const target = path.join(root, "测试剧", "海报封面");
    assert.equal(
      await readFile(path.join(target, dramaPosterOriginalImageDirectoryName, "刘晓-人物头像.png"), "utf8"),
      "actor-bytes",
    );
    assert.equal(
      await readFile(path.join(target, dramaPosterTextDirectoryName, "剧情角色介绍.txt"), "utf8"),
      "刘晓：货车司机。",
    );
    const manifest = JSON.parse(
      await readFile(path.join(target, dramaPosterSourceManifestFileName), "utf8"),
    ) as { images: Array<{ originalName: string }> };
    assert.ok(manifest.images.some((item) => item.originalName === "刘晓-人物头像.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
