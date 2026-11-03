import type { Page } from "playwright";
import type { TaobaoSubmitCheckpoint } from "../shared/task-execution.js";

export function hasUnconfirmedTaobaoSubmission(checkpoints: TaobaoSubmitCheckpoint[]) {
  const latest = new Map<string, TaobaoSubmitCheckpoint>();
  for (const checkpoint of checkpoints) {
    latest.set(`${checkpoint.kind}:${checkpoint.startEpisode ?? ""}:${checkpoint.endEpisode ?? ""}`, checkpoint);
  }
  return [...latest.values()].some((checkpoint) => checkpoint.state === "submitting");
}

export async function runWithTaobaoPageRecovery<T>(options: {
  page: Page;
  publish: (page: Page) => Promise<T>;
  checkpoints: () => TaobaoSubmitCheckpoint[];
  onRecovered: (page: Page, attempt: number) => void;
  isRunning: () => boolean;
}) {
  const context = options.page.context();
  let page = options.page;
  for (let attempt = 0; ; attempt++) {
    try {
      return await options.publish(page);
    } catch (error) {
      if (!page.isClosed() || !options.isRunning() || attempt >= 3
        || hasUnconfirmedTaobaoSubmission(options.checkpoints())) throw error;
      // Re-run the existing collection query and missing-episode planner in the
      // same claimed execution. Never claim another task or blindly resubmit.
      page = await context.newPage();
      options.onRecovered(page, attempt + 1);
    }
  }
}
