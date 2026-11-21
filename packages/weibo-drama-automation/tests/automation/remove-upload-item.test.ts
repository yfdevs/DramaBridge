import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "playwright";
import { removeWeiboUploadItem } from "../../src/automation/remove-upload-item.js";

test("deletion waits for the original node to detach before the next item can be removed", async () => {
  let disposed = false;
  let clicked = false;
  let completed = false;
  let finishTransition!: () => void;
  const node = { isConnected: true };
  const handle = {
    dispose: async () => {
      disposed = true;
    },
  };
  const item = { elementHandle: async () => handle } as unknown as Locator;
  const page = {
    waitForFunction: async (
      predicate: (element: { isConnected: boolean }) => boolean,
      actual: unknown,
    ) => {
      assert.equal(
        actual,
        handle,
        "must track the removed node, not a locator that shifts to another item",
      );
      assert.equal(clicked, true);
      assert.equal(predicate(node), false, "a leave animation still has a connected DOM node");
      await new Promise<void>((resolve) => {
        finishTransition = () => {
          node.isConnected = false;
          resolve();
        };
      });
      assert.equal(predicate(node), true);
    },
  } as unknown as Page;
  const pending = removeWeiboUploadItem(page, item, async () => {
    clicked = true;
  }).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(disposed, false);
  finishTransition();
  await pending;
  assert.equal(completed, true);
  assert.equal(disposed, true);
});

test("deletion failure releases the original node and prevents continuing with another item", async () => {
  let disposed = false;
  const item = {
    elementHandle: async () => ({
      dispose: async () => {
        disposed = true;
      },
    }),
  } as unknown as Locator;
  const page = {
    waitForFunction: async () => {
      throw new Error("transition timed out");
    },
  } as unknown as Page;
  await assert.rejects(
    removeWeiboUploadItem(page, item, async () => undefined),
    /transition timed out/,
  );
  assert.equal(disposed, true);
});
