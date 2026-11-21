import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFirstFourEpisodes, DEFAULT_DRAMA_WORKFLOW_SETTINGS } from "../src/drama-workflow.js";
import { randomSplitPlan } from "../src/plan.js";

test("episodes one through four are selected without changing directory order", () => {
  const inputs=[10,4,2,6,1,3].map(episode=>({episode,source:`${episode}.mp4`}));
  const before=structuredClone(inputs);
  assert.deepEqual(selectFirstFourEpisodes(inputs).map(item=>item.episode),[1,2,3,4]);
  assert.deepEqual(inputs,before);
});

test("missing or duplicate required episodes are rejected", () => {
  const inputs=[1,2,3,4].map(episode=>({episode,source:`${episode}.mp4`}));
  assert.throws(()=>selectFirstFourEpisodes(inputs.slice(0,3)),/缺少第 4 集/);
  assert.throws(()=>selectFirstFourEpisodes([...inputs,inputs[0]]),/多个文件/);
  assert.throws(()=>selectFirstFourEpisodes(inputs.slice(1)),/缺少第 1 集/);
});

test("longer fragment defaults do not leave a tiny tail", () => {
  const { minSeconds, maxSeconds } = DEFAULT_DRAMA_WORKFLOW_SETTINGS;
  for (const duration of [31, 60, 97, 120.45, 245.77]) {
    const clips = randomSplitPlan(duration, minSeconds, maxSeconds);
    assert.ok(clips.every(clip => clip.duration >= minSeconds && clip.duration <= maxSeconds));
    assert.ok(Math.abs(clips.reduce((sum, clip) => sum + clip.duration, 0) - duration) < 1 / 30);
  }
});
