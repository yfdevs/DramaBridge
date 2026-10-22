import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findFiles,
  isPathInside,
  normalizePathKey,
  readJsonFile,
  safeFileName,
  writeJsonAtomic,
} from "../src/index.js";

test("findFiles matches nested files with stable absolute paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-file-utils-"));
  try {
    await writeFile(path.join(root, "one.mp4"), "one");
    await writeFile(path.join(root, "ignore.txt"), "ignore");
    const files = await findFiles("**/*.mp4", { cwd: root });
    assert.deepEqual(files.map(normalizePathKey), [normalizePathKey(path.join(root, "one.mp4"))]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("safeFileName handles Windows-reserved names and invalid characters", () => {
  assert.notEqual(safeFileName("CON"), "CON");
  assert.equal(safeFileName("剧名:第一季?.mp4"), "剧名-第一季-.mp4");
  assert.equal(safeFileName("   ", { fallback: "短剧" }), "短剧");
});

test("safeFileName preserves legal full-width punctuation in drama titles", () => {
  for (const title of [
    "我卖老宅供她开店，她让我睡美容床",
    "短剧：第一季（全６３集）！",
  ]) {
    assert.equal(safeFileName(title, { replacement: "_" }), title);
  }
});

test("path containment rejects siblings and accepts descendants", () => {
  const root = path.resolve("workspace", "assets");
  assert.equal(isPathInside(root, path.join(root, "task", "video.mp4")), true);
  assert.equal(isPathInside(root, path.resolve(root, "..", "outside.mp4")), false);
  assert.equal(isPathInside(root, root), false);
});

test("writeJsonAtomic creates parent directories and valid JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-file-utils-json-"));
  try {
    const file = path.join(root, "nested", "state.json");
    await writeJsonAtomic(file, { ready: true });
    assert.deepEqual(await readJsonFile(file), { ready: true });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
