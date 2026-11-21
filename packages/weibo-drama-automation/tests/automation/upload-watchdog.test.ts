import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { waitForWeiboEpisodeUploads } from "../../src/automation/episode-upload.js";
import { waitForWeiboAction } from "../../src/automation/action-result.js";

function uploadPage(count: number, advance = () => {}) {
  const cards = {
    count: async () => count,
    evaluateAll: async () => [{ text: "上传中 0%", complete: false }],
    nth: () => ({ locator: () => ({ count: async () => 0 }) }),
  };
  return {
    locator: (selector: string) => selector === ".expand-btn"
      ? { filter: () => ({ isVisible: async () => false }) }
      : selector === ".video-card" ? cards : { count: async () => 0 },
    waitForTimeout: async () => advance(),
  } as unknown as Page;
}

test("122 cards for 61 episodes fails immediately instead of waiting 120 minutes", async () => {
  await assert.rejects(waitForWeiboEpisodeUploads(uploadPage(122), Array(61).fill("episode.mp4"), {}), /COUNT_INVALID.*122\/61/);
});

test("unchanged upload progress stops after ten minutes", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  await assert.rejects(waitForWeiboEpisodeUploads(uploadPage(1, () => { now += 60_000; }), ["episode.mp4"], {}), /UPLOAD_STALLED/);
  assert.equal(now, 10 * 60_000);
});

test("an unresolved platform action has its own deadline", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const page = {
    locator: () => ({ allInnerTexts: async () => [] }),
    waitForTimeout: async () => { now += 1000; },
  } as unknown as Page;
  await assert.rejects(waitForWeiboAction(page, async () => {}, new Promise(() => {}), { timeoutMs: 2000 }), /ACTION_TIMEOUT/);
});

test("a slow upload that continues progressing is allowed to complete", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const page = uploadPage(1, () => { now += 60_000; });
  const locator = page.locator.bind(page);
  t.mock.method(page, "locator", (selector: string) => {
    if (selector === ".video-card .play-icon") return { count: async () => now >= 12 * 60_000 ? 1 : 0 };
    const result = locator(selector);
    if (selector === ".video-card")
      return { ...result, count: async () => 1, nth: () => ({ locator: () => ({ count: async () => 0 }) }), evaluateAll: async () => [{ percent: now / 60_000 }] };
    return result;
  });
  await waitForWeiboEpisodeUploads(page, ["episode.mp4"], {});
  assert.equal(now, 12 * 60_000);
});
