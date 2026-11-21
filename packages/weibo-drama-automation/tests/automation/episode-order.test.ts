import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import type { Page } from "playwright";
import { restoreWeiboEpisodeOrder } from "../../src/automation/episode-upload.js";

function uploadPage(files: string[], allowDrag = true) {
  const displayed = [...files];
  let hovered = "";
  const cover = (index: number) => ({
    index,
    dragTo: async (target: { index: number }) => {
      if (allowDrag) displayed.splice(target.index, 0, displayed.splice(index, 1)[0]);
    },
    first: () => ({
      hover: async () => {
        hovered = path.basename(displayed[index]);
      },
      getAttribute: async () => `card-${index}`,
    }),
  });
  const page = {
    locator: (selector: string) =>
      selector === ".expand-btn"
        ? { filter: () => ({ isVisible: async () => false }) }
        : selector.startsWith('[id="card-')
          ? {
              waitFor: async () => undefined,
              innerText: async () => hovered,
            }
          : {
              count: async () => displayed.length,
              nth: (index: number) => ({ locator: () => cover(index) }),
            },
  } as unknown as Page;
  return { page, displayed };
}

test("out-of-order ready files are restored to real episode order before submission", async () => {
  const files = [1, 2, 3, 4, 5].map((index) => `剧名-第${index}集.mp4`);
  const arrived = [files[3], files[4], files[1], files[0], files[2]];
  const { page, displayed } = uploadPage(arrived);
  await restoreWeiboEpisodeOrder(page, arrived, files, {});
  assert.deepEqual(displayed, files);
});

test("a refused drag or an incomplete upload set cannot pass episode order verification", async () => {
  const files = ["剧名-第1集.mp4", "剧名-第2集.mp4"];
  const arrived = [...files].reverse();
  const { page } = uploadPage(arrived, false);
  await assert.rejects(restoreWeiboEpisodeOrder(page, arrived, files, {}), /UPLOAD_ORDER_INVALID/);
  await assert.rejects(
    restoreWeiboEpisodeOrder(page, [files[0]], files, {}),
    /UPLOAD_ORDER_INVALID/,
  );
});
