import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareTaobaoEpisodeVideos } from "../../src/shared/local-materials.js";

test("a 51-episode repair prepares episode 19 without requiring the other 50 files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "taobao-repair-local-"));
  try {
    const directory = path.join(root, "补传剧");
    await mkdir(directory);
    const source = path.join(directory, "补传剧 - 第19集.mp4");
    await writeFile(source, "episode19");
    const result = await prepareTaobaoEpisodeVideos({ id: "repair", originalTitle: "补传剧", episodeCount: 51,
      baiduPanResourceLink: "https://pan.baidu.com/s/test" }, {
      localMaterialRoot: root, assetDownloadDir: path.join(root, "temporary"), collectionUploadPlan: {
        collectionId: "1", title: "补传剧", episodeCount: 51, uploadedEpisodeNumbers: [], missingEpisodeNumbers: [19],
      },
    });
    assert.deepEqual(result.episodes.map(episode => episode.index), [19]);
    assert.equal(result.episodes[0].file, source);
    assert.equal(result.prepared.files.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
