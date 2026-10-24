import type { BrowserContext } from "playwright";
import { queryTaobaoCollectionDetail } from "../api/collection-detail.js";
import { applyTaobaoConfirmedSubmissions, createTaobaoCollectionUploadPlan, type TaobaoCollectionUploadPlan } from "../shared/collection-resume.js";
import type { TaobaoDramaRuntimeOptions } from "../shared/types.js";

export function restoreTaobaoConfirmedSubmissions(plan: TaobaoCollectionUploadPlan, options: TaobaoDramaRuntimeOptions) {
  const submitted: number[] = [];
  const uncertain: number[] = [];
  if (options.executionStore && options.apiConfig?.baseUrl && options.accountId) {
    for (const record of options.executionStore.list(options.apiConfig.baseUrl, options.accountId)) {
      const latest = new Map<string, typeof record.checkpoints[number]>();
      for (const checkpoint of record.checkpoints) {
        if (checkpoint.kind !== "batch" || checkpoint.collectionId !== plan.collectionId || !checkpoint.episodeNumbers?.length) continue;
        latest.set([...checkpoint.episodeNumbers].sort((a, b) => a - b).join(","), checkpoint);
      }
      for (const checkpoint of latest.values()) {
        (checkpoint.state === "confirmed" ? submitted : uncertain).push(...checkpoint.episodeNumbers!);
      }
    }
  }
  const restored = applyTaobaoConfirmedSubmissions(plan, submitted);
  const missing = new Set(restored.missingEpisodeNumbers);
  if (uncertain.some((episode) => missing.has(episode))) throw new Error(
    "TAOBAO_DRAMA_COLLECTION_SUBMISSION_UNCERTAIN: 该合集有已点击发布但未确认结果的集数，作品列表可能尚未更新，已暂停自动补传，请先核实原提交结果。",
  );
  return restored;
}

// Check before uploading only. Page-confirmed submissions cover the period
// before the collection service reflects newly published videos.
export async function refreshTaobaoCollectionUploadPlan(
  context: BrowserContext, plan: TaobaoCollectionUploadPlan, options: TaobaoDramaRuntimeOptions = {},
) {
  const current = createTaobaoCollectionUploadPlan(await queryTaobaoCollectionDetail(context, plan.collectionId), plan.title, plan.episodeCount);
  return restoreTaobaoConfirmedSubmissions(applyTaobaoConfirmedSubmissions(current, plan.submittedEpisodeNumbers ?? []), options);
}
