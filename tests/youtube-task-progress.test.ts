import assert from "node:assert/strict";
import test from "node:test";
import {
  youtubeTaskPercent,
  youtubeBytes,
  youtubeSpeed,
} from "../src/pages/youtube-drama/task-progress-data";
import type { YoutubeTask } from "../src/platforms/youtube-drama/service";

test("download progress prefers native byte totals over an old cached percentage", () => {
  const task = {
    status: "downloading",
    progress: {
      stage: "downloading",
      percent: 4,
      transferredBytes: 1911338651,
      totalBytes: 4768412310,
    },
  } as YoutubeTask;
  assert.equal(youtubeTaskPercent(task)?.toFixed(1), "40.1");
  assert.equal(
    youtubeTaskPercent({ ...task, progress: { ...task.progress, transferredBytes: 0 } }),
    0,
  );
  assert.equal(youtubeTaskPercent({ ...task, progress: { stage: "downloading" } }), null);
  assert.equal(youtubeTaskPercent({ ...task, progress: { ...task.progress, totalBytes: 0 } }), 4);
  assert.equal(
    youtubeTaskPercent({ ...task, progress: { ...task.progress, totalBytes: Infinity } }),
    4,
  );
  assert.equal(youtubeTaskPercent({ ...task, status: "completed" }), 100);
});

test("pipeline percentages remain stage-specific and native speed has readable units", () => {
  const task = {
    status: "processing",
    progress: { stage: "separating", percent: 62.5, transferredBytes: 100, totalBytes: 100 },
  } as YoutubeTask;
  assert.equal(youtubeTaskPercent(task), 62.5);
  assert.equal(youtubeTaskPercent({ ...task, progress: { percent: NaN } }), null);
  assert.equal(youtubeSpeed("6140023"), "5.86 MB/s");
  assert.equal(youtubeSpeed("2.1 × 实时"), "2.1 × 实时");
  assert.equal(youtubeBytes(0), "0 B");
});
