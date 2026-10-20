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

test("reports the episode and original source when a video is corrupt", async () => {
  const failure = new Error(
    "[video-transcode-failed] FFmpeg exited: moov atom not found; Invalid data found when processing input",
  );
  await assert.rejects(
    prepareShortDouyinEpisodeVideos(["临时剧名-第40集.mp4"], {
      concurrency: 1,
      sourceFiles: ["D:\\BaiduNetdiskDownload\\测试剧\\测试剧 - 第40集.mp4"],
      readDuration: async () => {
        throw failure;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DOUYIN_DRAMA_EPISODE_VIDEO_INVALID/);
      assert.match(error.message, /episode=40/);
      assert.match(error.message, /测试剧 - 第40集\.mp4/);
      assert.match(error.message, /reason=moov-atom-not-found/);
      assert.equal((error as Error & { cause?: unknown }).cause, failure);
      return true;
    },
  );
});

test("falls back to the original source when the temporary upload link cannot be probed", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const result = await prepareShortDouyinEpisodeVideos(["D:\\temp\\测试剧-第28集.mp4"], {
    concurrency: 1,
    sourceFiles: ["D:\\BaiduNetdiskDownload\\测试剧\\测试剧 - 第28集.mp4"],
    readDuration: async (file) => {
      calls.push(file);
      if (file.includes("\\temp\\")) throw new Error("transient probe failure");
      return 45;
    },
    onLog: (message) => logs.push(message),
  });

  assert.deepEqual(calls, [
    "D:\\temp\\测试剧-第28集.mp4",
    "D:\\BaiduNetdiskDownload\\测试剧\\测试剧 - 第28集.mp4",
  ]);
  assert.equal(result[0]?.sourceDurationSeconds, 45);
  assert.match(logs.join("\n"), /改用原始视频复核/);
});
