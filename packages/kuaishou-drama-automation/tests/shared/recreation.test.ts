import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { normalizeKuaishouRecreationCover, prepareKuaishouRecreationVersion, inspectKuaishouRecreationVersion } from "../../src/recreation.js";

test("recreation selects first episodes and copies into isolated renamed versions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-files-"));
  try {
    const source = path.join(root, "原剧");
    await mkdir(path.join(source, "封面"), { recursive: true });
    for (let index = 1; index <= 5; index++)
      await writeFile(path.join(source, `原剧-第${index}集.mp4`), `episode${index}`);
    await sharp({ create: { width: 32, height: 48, channels: 3, background: "red" } })
      .png()
      .toFile(path.join(source, "封面", "海报.png"));
    await sharp({ create: { width: 32, height: 48, channels: 3, background: "blue" } })
      .png().toFile(path.join(source, "封面", "海报2.png"));
    const output = await prepareKuaishouRecreationVersion({
      source,
      originalTitle: "原剧",
      title: "新剧",
      episodeCount: 3,
      outputRoot: path.join(root, "output"),
    });
    assert.deepEqual((await readdir(path.join(output, "成片"))).sort(), [
      "新剧-第1集.mp4",
      "新剧-第2集.mp4",
      "新剧-第3集.mp4",
    ]);
    assert.equal(await readFile(path.join(output, "成片", "新剧-第2集.mp4"), "utf8"), "episode2");
    assert.deepEqual(await readdir(path.join(output, "封面")), ["封面.png"]);
    await writeFile(path.join(output, "封面", "新剧-封面1.png"), "old cover");
    await writeFile(path.join(output, "封面", "新剧-封面2.png"), "extra old cover");
    assert.equal(await inspectKuaishouRecreationVersion(output, "新剧", 3), undefined);
    await normalizeKuaishouRecreationCover(output, "新剧");
    assert.deepEqual(await readdir(path.join(output, "封面")), ["封面.png"]);
    assert.ok(await inspectKuaishouRecreationVersion(output, "新剧", 3));
    assert.equal((await readdir(source)).length, 6);
    await assert.rejects(
      prepareKuaishouRecreationVersion({
        source,
        originalTitle: "原剧",
        title: "缺集",
        episodeCount: 6,
        outputRoot: root,
      }),
      /集数不完整/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
