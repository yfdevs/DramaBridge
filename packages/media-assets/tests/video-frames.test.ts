import assert from "node:assert/strict";
import test from "node:test";

import { selectRandomVideoFrameTimestamps } from "../src/video-transcode.js";

test("selects one random frame from each safe video segment", () => {
  const values = [0.25, 0.75];
  const timestamps = selectRandomVideoFrameTimestamps(100, 2, () => values.shift() ?? 0);

  assert.deepEqual(timestamps, [20, 80]);
  assert.ok(timestamps[0]! >= 10 && timestamps[0]! < 50);
  assert.ok(timestamps[1]! >= 50 && timestamps[1]! < 90);
});

test("clamps random values and rejects invalid requests", () => {
  const timestamps = selectRandomVideoFrameTimestamps(10, 2, () => 2);
  assert.ok(timestamps[0]! < 5);
  assert.ok(timestamps[1]! < 9);
  assert.throws(() => selectRandomVideoFrameTimestamps(0), /视频时长无效/);
  assert.throws(() => selectRandomVideoFrameTimestamps(10, 0), /截图数量/);
});
