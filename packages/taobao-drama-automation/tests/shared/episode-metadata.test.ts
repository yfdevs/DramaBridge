import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DramaAiClient } from "@drama/ai";

import {
  collectTaobaoSynopsis,
  createTaobaoCollectionMetadata,
  formatTaobaoHashtags,
  formatTaobaoVideoDescription,
  prepareTaobaoEpisodeMetadata,
  taobaoContentTags,
} from "../../src/shared/episode-metadata.js";

test("derives collection fields for the newly created Taobao collection", () => {
  const collection = createTaobaoCollectionMetadata({
    id: "task-collection",
    originalTitle: "闪婚千金逆袭",
    baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
    episodeCount: 2,
  }, {
    dramaTag: "逆袭",
    episodeSummaries: ["意外闪婚", "身份揭晓"],
    synopsisText: "女主遭遇背叛后闪婚，最终完成逆袭。",
  });

  assert.deepEqual(collection, {
    title: "闪婚千金逆袭",
    summary: "女主遭遇背叛后闪婚，最终完成逆袭。\n第1集：意外闪婚；第2集：身份揭晓",
    episodeCount: 2,
    shortDramaType: "AI动漫短剧",
    shortDramaTags: ["AI动漫解说漫", "逆袭"],
    audience: "女",
  });
});

test("reads synopsis text and generates all episode summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taobao-metadata-"));
  const resourceDir = path.join(root, "逆风翻盘", "海报封面", "剧情资料");
  await mkdir(resourceDir, { recursive: true });
  await writeFile(path.join(resourceDir, "简介.txt"), "男主遭到背叛后寻找证据并完成反击。", "utf8");
  const client = {
    async generateText() {
      return {
        finishReason: "stop",
        model: "test-model",
        text: JSON.stringify({
          tag: "都市",
          episodes: [
            { episode: 1, summary: "男主意外发现骗局" },
            { episode: 2, summary: "搜集证据成功反击" },
          ],
        }),
      };
    },
  } as DramaAiClient;
  try {
    const synopsis = await collectTaobaoSynopsis(path.join(root, "逆风翻盘"));
    assert.match(synopsis.text ?? "", /男主遭到背叛/);
    const metadata = await prepareTaobaoEpisodeMetadata({
      id: "task-1",
      originalTitle: "逆风翻盘",
      baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
      episodeCount: 2,
    }, {
      localMaterialRoot: root,
      aiClientFactory: () => client,
    });
    assert.equal(metadata.dramaTag, "都市");
    assert.deepEqual(metadata.episodeSummaries, ["男主意外发现骗局", "搜集证据成功反击"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generates metadata in 100-episode ranges for a long Taobao drama", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taobao-long-metadata-"));
  await mkdir(path.join(root, "千集长剧"), { recursive: true });
  const requestedRanges: string[] = [];
  const client = {
    async generateText(request: Parameters<DramaAiClient["generateText"]>[0]) {
      const match = request.prompt.match(/本次只输出第(\d+)集到第(\d+)集/);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Number(match[2]);
      requestedRanges.push(`${start}-${end}`);
      return {
        finishReason: "stop" as const,
        model: "test-model",
        text: JSON.stringify({
          tag: "都市",
          episodes: Array.from({ length: end - start + 1 }, (_, index) => ({
            episode: start + index,
            summary: `剧情推进${start + index}`,
          })),
        }),
      };
    },
  } as DramaAiClient;
  try {
    const metadata = await prepareTaobaoEpisodeMetadata({
      id: "task-long",
      originalTitle: "千集长剧",
      baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
      episodeCount: 101,
    }, {
      localMaterialRoot: root,
      aiClientFactory: () => client,
    });
    assert.deepEqual(requestedRanges, ["1-100", "101-101"]);
    assert.equal(metadata.episodeSummaries.length, 101);
    assert.equal(metadata.episodeSummaries[100], "剧情推进101");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formats Taobao description and hashtag text", () => {
  assert.equal(formatTaobaoVideoDescription(3, "第三集：女主揭开豪门秘密。"), "第3集|女主揭开豪门秘密");
  assert.deepEqual(taobaoContentTags("顺手牵羊的代价", "现代"), ["AI短剧", "现代"]);
  assert.equal(formatTaobaoHashtags("顺手牵羊的代价", "现代"), "#AI短剧 #现代");
});
