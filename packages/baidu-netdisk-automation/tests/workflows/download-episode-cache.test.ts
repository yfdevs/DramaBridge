import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { selectIncompleteEpisodeDownloads } from "../../src/workflows/download-episode-cache.js";

test("29 complete episodes are reused and only the missing two are selected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baidu-episode-cache-"));
  try {
    const content = Buffer.from("video");
    const episodes = Array.from({ length: 31 }, (_, index) => ({ name: `第${index + 1}集.mp4`, size: content.length, contentHash: createHash("md5").update(content).digest("hex") }));
    for (const episode of episodes.slice(0, 29)) await writeFile(path.join(root, episode.name), content);
    assert.deepEqual((await selectIncompleteEpisodeDownloads(episodes, root)).map(file => file.name), ["第30集.mp4", "第31集.mp4"]);
    await writeFile(path.join(root, "第1集.mp4"), "wrong"); // Same size, different content.
    assert.equal((await selectIncompleteEpisodeDownloads(episodes, root)).length, 3);
    await assert.rejects(selectIncompleteEpisodeDownloads([{ name: "../其他文件", size: 1 }], root), /无效路径/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
