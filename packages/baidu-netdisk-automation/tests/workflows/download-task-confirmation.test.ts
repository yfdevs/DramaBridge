import assert from "node:assert/strict";
import test from "node:test";
import { confirmSingleFileDownload } from "../../src/workflows/download-task-confirmation.js";

test("a delayed native task is accepted without another submission", async () => {
  let probes = 0;
  assert.equal(
    await confirmSingleFileDownload({
      inspect: async () => ++probes === 2,
      localComplete: async () => false,
      wait: async () => {},
    }),
    true,
  );
  assert.equal(probes, 2);
});

test("a task that completed and left the queue is confirmed from its local file", async () => {
  let probes = 0;
  assert.equal(
    await confirmSingleFileDownload({
      inspect: async () => {
        probes++;
        return false;
      },
      localComplete: async () => true,
      wait: async () => {},
    }),
    true,
  );
  assert.equal(probes, 1);
});

test("a missing file is eligible for retry only after bounded successful absence checks", async () => {
  let probes = 0;
  assert.equal(
    await confirmSingleFileDownload({
      inspect: async () => {
        probes++;
        return false;
      },
      localComplete: async () => false,
      wait: async () => {},
    }),
    false,
  );
  assert.equal(probes, 3);
});

test("native inspection failure does not authorize replaying an uncertain submission", async () => {
  let probes = 0;
  await assert.rejects(
    confirmSingleFileDownload({
      inspect: async () => {
        probes++;
        throw new Error("native timeout");
      },
      localComplete: async () => false,
      wait: async () => {},
    }),
    /native timeout/,
  );
  assert.equal(probes, 1);
});

test("a complete local file confirms acceptance even when the queue's remote object expired", async () => {
  let probes = 0;
  assert.equal(
    await confirmSingleFileDownload({
      inspect: async () => {
        probes++;
        throw new Error("Cannot get property 'tasks' on missing remote object 13710");
      },
      localComplete: async () => true,
      wait: async () => {},
    }),
    true,
  );
  assert.equal(probes, 1);
});
