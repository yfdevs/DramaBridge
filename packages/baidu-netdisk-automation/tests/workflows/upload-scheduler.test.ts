import assert from "node:assert/strict";
import test from "node:test";
import { runUploadJobs, UPLOAD_FILE_CONCURRENCY } from "../../src/workflows/upload-scheduler.js";

test("next files upload while an earlier file is still being verified, with a two-file bound", async () => {
  const starts: number[] = [];
  let finishVerification: () => void = () => undefined;
  const verification = new Promise<void>((resolve) => {
    finishVerification = resolve;
  });
  let active = 0,
    peak = 0;
  const pending = runUploadJobs(
    [1, 2, 3],
    async (index) => {
      starts.push(index);
      peak = Math.max(peak, ++active);
      try {
        if (index === 1) await verification;
      } finally {
        active--;
      }
    },
    UPLOAD_FILE_CONCURRENCY,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1, 2, 3]);
  assert.equal(active, 1, "first file verification is still pending after later files transfer");
  finishVerification();
  await pending;
  assert.equal(peak, 2);
});

test("a file failure cancels another file's verification and never schedules the next file", async () => {
  const error = new Error("校验失败");
  const starts: number[] = [];
  let rejectFirst: (reason: unknown) => void = () => undefined;
  let verificationStopped = false;
  const pending = runUploadJobs(
    [1, 2, 3],
    async (index, signal) => {
      starts.push(index);
      if (index === 1)
        await new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      else {
        try {
          await new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        } finally {
          verificationStopped = true;
        }
      }
    },
    UPLOAD_FILE_CONCURRENCY,
  );
  const rejection = assert.rejects(pending, (value) => value === error);
  rejectFirst(error);
  await rejection;
  assert.deepEqual(starts, [1, 2]);
  assert.equal(verificationStopped, true);
});
