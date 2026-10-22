import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DramaAiClient } from "@dramabridge/ai";

import {
  collectTaobaoSynopsis,
  createTaobaoCollectionMetadata,
  ensureTaobaoCollectionSynopsis,
  extractTaobaoCollectionSynopsis,
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
    productionCostProofFiles: [],
  }, {
    dramaTag: "逆袭",
    episodeSummaries: ["意外闪婚", "身份揭晓"],
    synopsisText: "女主遭遇背叛后闪婚，最终完成逆袭。",
  });

  assert.equal(collection.title, "闪婚千金逆袭");
  assert.match(collection.summary, /^女主遭遇背叛后闪婚，最终完成逆袭。/u);
  assert.ok(collection.summary.length >= 100);
  assert.equal(collection.episodeCount, 2);
  assert.equal(collection.shortDramaType, "AI动漫短剧");
  assert.deepEqual(collection.shortDramaTags, ["AI动漫解说漫", "逆袭"]);
  assert.equal(collection.audience, "女");
});

test("uses only the story synopsis for a Taobao collection", () => {
  const storySynopsis = "电商大促前夕，无良二房东王海恶意毁约企图敲诈。电商老板赵远文坚决不向恶势力妥协，果断当场退租，并为员工妥善安置了优质的园区公寓。面对反派雇人堵路、恶意举报消防隐患等卑劣手段，赵远文始终冷静应对，依靠规范管理与法律证据化解危机。最终，他查明违规群租房真相，联合真房东依法清算恶霸，带领团队在大促中创造佳绩。";
  const source = [
    "【海报封面\\剧情资料\\简介.txt】",
    "根据您上传的《从退租开始清算》故事内容，为您生成故事简介：",
    "### 故事简介（约150字）",
    storySynopsis,
    "---",
    "### 男主简介（约100字）",
    "**赵远文**：远文电商公司负责人。",
    "第1集：二房东恶意涨租毁约；第2集：赵远文当场决定退租",
  ].join("\n\n");

  assert.equal(extractTaobaoCollectionSynopsis(source), storySynopsis);
  const collection = createTaobaoCollectionMetadata({
    id: "task-pure-summary",
    originalTitle: "从退租开始清算",
    baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
    episodeCount: 2,
    productionCostProofFiles: [],
    summary: "过短的后台简介",
  }, {
    dramaTag: "都市",
    episodeSummaries: ["二房东恶意毁约", "男主当场决定退租"],
    synopsisText: source,
  });

  assert.equal(collection.summary, storySynopsis);
  assert.doesNotMatch(collection.summary, /简介\.txt|男主简介|第1集/u);
});

test("supplements a short collection synopsis to Taobao's minimum length", () => {
  const shortSummary = "少年在维修铺中意外获得特殊能力，从此能够感知物品背后的故事，并在一次次委托中帮助身边的人解决难题。";
  const summary = ensureTaobaoCollectionSynopsis({
    title: "守温维修铺",
    dramaTag: "都市",
    episodeSummaries: ["少年发现特殊能力", "维修委托暗藏秘密", "伙伴携手化解危机"],
    taskSummary: shortSummary,
  });

  assert.match(summary, new RegExp(`^${shortSummary}`, "u"));
  assert.ok(summary.length >= 100);
  assert.ok(summary.length <= 3_000);
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
  } as unknown as DramaAiClient;
  try {
    const synopsis = await collectTaobaoSynopsis(path.join(root, "逆风翻盘"));
    assert.match(synopsis.text ?? "", /男主遭到背叛/);
    const metadata = await prepareTaobaoEpisodeMetadata({
      id: "task-1",
      originalTitle: "逆风翻盘",
      baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
      episodeCount: 2,
      productionCostProofFiles: [],
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
      productionCostProofFiles: [],
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

test("uses the backend summary for AI metadata even without a local synopsis file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taobao-task-summary-"));
  const summary = "程满经营进货群五年，遭恶少讹诈后与兄弟齐心整顿市场乱象。";
  const logs: string[] = [];
  const prompts: string[] = [];
  const client = {
    async generateText(request: Parameters<DramaAiClient["generateText"]>[0]) {
      prompts.push(request.prompt);
      return { model: "test-model", finishReason: "stop", text: JSON.stringify({
        tag: "逆袭", episodes: [{ episode: 1, summary: "兄弟齐心反击恶少" }],
      }) };
    },
  } as DramaAiClient;
  try {
    await mkdir(path.join(root, "兄弟齐心"));
    const task = { id: "task-summary", originalTitle: "兄弟齐心",
      baiduPanResourceLink: "https://pan.baidu.com/s/example", episodeCount: 1,
      productionCostProofFiles: [], summary };
    const options = { localMaterialRoot: root, aiClientFactory: () => client,
      onLog: (message: string) => logs.push(message) };
    await prepareTaobaoEpisodeMetadata(task, options);
    assert.ok(prompts[0]?.includes(`任务剧情简介（主要依据）：${summary}`));
    assert.ok(logs.some(message => message.includes("使用任务提供的剧情简介")));
    assert.ok(!logs.some(message => message.includes("将使用剧名和百度链接")));
    assert.ok(!prompts[0]?.includes("请结合剧名生成"));

    await writeFile(path.join(root, "兄弟齐心", "简介.txt"), "兄弟们先后现身，揭穿恶少骗局。", "utf8");
    await prepareTaobaoEpisodeMetadata(task, options);
    assert.ok(prompts[1]?.includes(summary));
    assert.ok(prompts[1]?.includes("补充剧情资料："));
    assert.ok(prompts[1]?.includes("兄弟们先后现身"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formats Taobao description and hashtag text", () => {
  assert.equal(formatTaobaoVideoDescription(3, "第三集：女主揭开豪门秘密。"), "第3集|女主揭开豪门秘密");
  assert.deepEqual(taobaoContentTags("顺手牵羊的代价", "现代"), [
    "AI短剧",
    "现代",
    "顺手牵羊的代价",
  ]);
  assert.equal(
    formatTaobaoHashtags("顺手牵羊的代价", "现代"),
    "#AI短剧 #现代 #顺手牵羊的代价",
  );
});
