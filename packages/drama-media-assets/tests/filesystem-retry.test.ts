import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientFileSystemError,
  retryFileSystemOperation,
} from "../src/filesystem-retry.js";

test("retries transient Windows file locks and returns the eventual result", async () => {
  let attempts = 0;
  const result = await retryFileSystemOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("file is locked") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return "done";
  }, { maximumAttempts: 3, initialDelayMs: 0 });

  assert.equal(result, "done");
  assert.equal(attempts, 3);
});

test("does not retry a permanent filesystem failure", async () => {
  let attempts = 0;
  await assert.rejects(
    retryFileSystemOperation(async () => {
      attempts += 1;
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }, { maximumAttempts: 3, initialDelayMs: 0 }),
    { code: "ENOENT" },
  );
  assert.equal(attempts, 1);
  assert.equal(isTransientFileSystemError({ code: "EBUSY" }), true);
});
