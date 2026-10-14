import assert from "node:assert/strict";
import test from "node:test";
import { prepareShortDouyinEpisodeVideos } from "../../src/automation/episode-speed.js";

test("slows only Douyin episode videos at or below 30 seconds", async () => {
  const durations = new Map([
    ["episode-1.mp4", 29.99],
    ["episode-2.mp4", 30],
    ["episode-3.mp4", 30.01],
  ]);
  const adjusted: Array<{ inputFile: string; speed: number }> = [];
  const result = await prepareShortDouyinEpisodeVideos([...durations.keys()], {
    concurrency: 1,
    readDuration: async (file) => durations.get(file)!,
    adjustSpeed: async (request) => {
      adjusted.push({ inputFile: request.inputFile, speed: request.speed });
      return {
        file: request.inputFile,
        speed: request.speed,
        sourceDurationSeconds: request.sourceDurationSeconds!,
        outputDurationSeconds: request.sourceDurationSeconds! / request.speed,
        outputVideoDurationSeconds: request.sourceDurationSeconds! / request.speed,
        outputAudioDurationSeconds: request.sourceDurationSeconds! / request.speed,
      };
    },
  });

  assert.deepEqual(adjusted, [
    { inputFile: "episode-1.mp4", speed: 0.9 },
    { inputFile: "episode-2.mp4", speed: 0.9 },
  ]);
  assert.equal(result[0]?.adjusted?.outputDurationSeconds.toFixed(2), "33.32");
  assert.equal(result[1]?.adjusted?.outputDurationSeconds.toFixed(2), "33.33");
  assert.equal(result[2]?.adjusted, undefined);
});
