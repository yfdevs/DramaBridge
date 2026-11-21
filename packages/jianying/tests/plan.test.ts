import assert from "node:assert/strict";
import { test } from "node:test";
import { randomSplitPlan } from "../src/plan.js";

test("random cuts cover the whole video without gaps, overlaps or short tails", () => {
  for (let seconds = 9; seconds <= 1000; seconds += 7.13) {
    for (const sample of [() => 0, () => 0.999999, Math.random]) {
      const clips = randomSplitPlan(seconds, 3, 8, sample);
      let end = 0;
      for (const clip of clips) {
        assert.ok(Math.abs(clip.start - end) < 1e-8);
        assert.ok(clip.duration >= 3 && clip.duration <= 8);
        end += clip.duration;
      }
      assert.ok(Math.abs(end - seconds) <= 1 / 60 + 1e-8);
    }
  }
});
test("short inputs remain one clip and impossible constraints fail explicitly", () => {
  assert.equal(randomSplitPlan(1, 3, 8).length, 1);
  assert.throws(() => randomSplitPlan(10, 6, 8), /放宽/);
  assert.throws(() => randomSplitPlan(60, NaN, 8));
  assert.throws(() => randomSplitPlan(60, 9, 3));
  assert.throws(() => randomSplitPlan(86401, 3, 8));
  assert.throws(() => randomSplitPlan(60, 3, 8, () => 1));
});
test("different randomness produces different cuts and no more than 500 clips", () => {
  assert.notDeepEqual(randomSplitPlan(60, 3, 8, () => 0), randomSplitPlan(60, 3, 8, () => 0.9));
  assert.throws(() => randomSplitPlan(10000, 0.5, 1), /500/);
});
