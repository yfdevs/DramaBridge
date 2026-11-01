import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetLocalResourceForRedownload } from "../../electron/platforms/baidu-netdisk/redownload";

test("redownload cancels native writers before deleting only this show's files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-redownload-"));
  try {
    const localRoot = path.join(root, "materials");
    const show = path.join(localRoot, "测试剧");
    const sibling = path.join(localRoot, "其他剧");
    const downloadDir = path.join(root, "download__1234567890");
    for (const directory of [show, sibling, downloadDir]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "1.mp4"), "old");
    }
    await resetLocalResourceForRedownload({
      localRoot, resourceName: "测试剧", downloadDir,
      cancelDownloads: async () => {
        assert.equal(await readFile(path.join(show, "1.mp4"), "utf8"), "old");
        assert.equal(await readFile(path.join(downloadDir, "1.mp4"), "utf8"), "old");
      },
    });
    await assert.rejects(readFile(path.join(show, "1.mp4")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(downloadDir, "1.mp4")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(sibling, "1.mp4"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redownload refuses unsafe scopes and keeps files when native cancellation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-redownload-"));
  try {
    const show = path.join(root, "测试剧");
    await mkdir(show);
    await writeFile(path.join(show, "1.mp4"), "old");
    for (const resourceName of ["", ".", "..", "../other", "nested/show"]) {
      await assert.rejects(resetLocalResourceForRedownload({
        localRoot: root, resourceName, downloadDir: path.join(root, "temp"),
        cancelDownloads: async () => { assert.fail("unsafe paths must fail before cancellation"); },
      }), /不安全/);
    }
    await assert.rejects(resetLocalResourceForRedownload({
      localRoot: root, resourceName: "测试剧", downloadDir: path.join(root, "temp"),
      cancelDownloads: async () => { throw new Error("client unavailable"); },
    }), /client unavailable/);
    assert.equal(await readFile(path.join(show, "1.mp4"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
