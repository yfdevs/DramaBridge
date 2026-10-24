import { z } from "zod";
import type { BrowserContext } from "playwright";
import { requestTaobaoMtop } from "./collection-list.js";

const id = z.union([z.string().trim().min(1), z.number().int().positive()]).transform(String);
const collectionDetailSchema = z.object({
  collectionInfo: z.object({
    collectionId: id, title: z.string().trim().min(1),
    contentCount: z.coerce.number().int().nonnegative(),
    episodeCount: z.coerce.number().int().positive(),
    contentIds: z.array(id),
  }),
  // Taobao omits contentCards entirely for an empty collection.
  contentCards: z.array(z.object({ baseInfo: z.object({
    id, collectionId: id, title: z.string().trim().min(1),
  }) })).default([]),
});
export type TaobaoCollectionDetail = z.infer<typeof collectionDetailSchema>;

export function parseTaobaoCollectionDetail(data: unknown, collectionId: string): TaobaoCollectionDetail {
  const parsed = z.object({ model: collectionDetailSchema }).safeParse(data);
  if (!parsed.success) throw new Error(
    "TAOBAO_DRAMA_COLLECTION_DETAIL_INVALID: 合集详情缺少完整的视频列表或集数信息，已停止上传，请检查淘宝合集详情后重试。",
  );
  const detail = parsed.data.model;
  if (detail.collectionInfo.collectionId !== collectionId) throw new Error(
    "TAOBAO_DRAMA_COLLECTION_DETAIL_ID_MISMATCH: 返回的合集与目标合集不一致，已停止上传。",
  );
  return detail;
}

export async function queryTaobaoCollectionDetail(context: BrowserContext, collectionId: string) {
  if (!collectionId.trim()) throw new Error("TAOBAO_DRAMA_COLLECTION_ID_REQUIRED");
  return parseTaobaoCollectionDetail(await requestTaobaoMtop(context, "mtop.taobao.gcm.collection.detail", "2.0", {
    mode: "0", agentType: "", agentId: "", collectionId,
  }), collectionId);
}
