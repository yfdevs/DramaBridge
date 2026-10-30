import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planUploadDirectory, type RemoteUploadEntry } from "../../src/workflows/upload-directory-plan.js";

test("same-name conflicts stay in the canonical directory and produce a targeted cleanup plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baidu-upload-plan-"));
  try {
    await mkdir(path.join(root, "封面"));
    await writeFile(path.join(root, "封面", "原剧-封面1.png"), "new cover");
    const base = "/快手_二创集合/原剧/原剧-60%";
    const directory = (value: string): RemoteUploadEntry => ({ server_filename: path.posix.basename(value), path: value, isdir: 1, size: 0 });
    const cloud = new Map<string, RemoteUploadEntry[]>([
      [path.posix.dirname(base), [directory(base), directory(base + "汇总")]],
      [base, [directory(base + "/封面")]],
      [base + "/封面", [{ server_filename: "原剧-封面1.png", path: base + "/封面/原剧-封面1.png", isdir: 0, size: 9, md5: "different" }]],
      [base + "汇总", [{ server_filename: "额外文件", path: base + "汇总/额外文件", isdir: 0, size: 1 }]],
    ]);
    const options = { localDirectory: root, remoteDirectory: base, list: async (dir: string) => cloud.get(dir) ?? [] };
    const first = await planUploadDirectory(options);
    assert.equal(first.remoteDirectory, base);
    assert.deepEqual(first.conflicts.map(file => file.path), [base + "/封面/原剧-封面1.png"]);
    assert.equal(first.reuseFrom, undefined);
    assert.equal(first.legacyDirectories.length, 1);
    cloud.get(base + "/封面")![0].md5 = first.identities.get(path.join(root, "封面", "原剧-封面1.png"))!.md5;
    const retry = await planUploadDirectory({ ...options, preferredRemoteDirectory: base + "汇总" });
    assert.equal(retry.remoteDirectory, base);
    assert.equal(retry.conflicts.length, 0);
    assert.equal(retry.reuseFrom, undefined);
    await assert.rejects(planUploadDirectory({ ...options, remoteDirectory: "/快手_二创集合/原剧" }), /无效的二创版本目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
