import { createHash } from "node:crypto";
import { z } from "zod";
import type { BrowserContext } from "playwright";

const mtopOrigin = "https://h5api.m.taobao.com";
const collectionListApi = "mtop.taobao.gcm.collection.list.query";
const collectionListVersion = "1.0";
const defaultAppKey = "12574478";
const tokenCookieName = "_m_h5_tk";

const mtopResponseSchema = z.object({
  api: z.string().optional(),
  data: z.unknown().optional(),
  ret: z.array(z.string()).optional(),
}).passthrough();

const collectionListModelSchema = z.object({
  data: z.array(z.object({
    collectionInfo: z.object({
      collectionId: z.union([z.string(), z.number()]),
      contentCount: z.coerce.number().int().nonnegative(),
    }).passthrough(),
  }).passthrough()),
  pageCount: z.coerce.number().int().nonnegative(),
  pageIndex: z.coerce.number().int().positive(),
  totalCount: z.coerce.number().int().nonnegative(),
}).passthrough();

export type TaobaoCollectionListItem = z.infer<typeof collectionListModelSchema>["data"][number];
export type TaobaoCollectionListPage = z.infer<typeof collectionListModelSchema>;

export type TaobaoCollectionListQuery = {
  pageNo?: number;
  pageSize?: number;
  keyword?: string;
  auditStatus?: number | null;
  typeList?: number[];
};

type MtopRequestInput = {
  api: string;
  version: string;
  data: Record<string, unknown>;
  token: string;
  timestamp: number;
  appKey?: string;
  callback?: string;
};

function parseJsonp(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("TAOBAO_MTOP_RESPONSE_INVALID");
  return mtopResponseSchema.parse(JSON.parse(value.slice(start, end + 1)));
}

function tokenFromCookieValue(value: string) {
  return value.split("_", 1)[0]?.trim() ?? "";
}

export function createTaobaoMtopRequest(input: MtopRequestInput) {
  const appKey = input.appKey ?? defaultAppKey;
  const data = JSON.stringify(input.data);
  const timestamp = String(input.timestamp);
  const sign = createHash("md5")
    .update(`${input.token}&${timestamp}&${appKey}&${data}`, "utf8")
    .digest("hex");
  const query = new URLSearchParams({
    jsv: "2.6.1",
    appKey,
    t: timestamp,
    sign,
    api: input.api,
    v: input.version,
    dataType: "originaljsonp",
    syncCookieMode: "true",
    preventFallback: "true",
    type: "originaljsonp",
    callback: input.callback ?? "mtopjsonp1",
    data,
  });
  return {
    data,
    sign,
    url: `${mtopOrigin}/h5/${input.api.toLowerCase()}/${input.version.toLowerCase()}/?${query}`,
  };
}

function isSuccessfulMtopResponse(payload: z.infer<typeof mtopResponseSchema>) {
  return payload.ret?.some((item) => item.startsWith("SUCCESS")) === true;
}

function isTokenFailure(payload: z.infer<typeof mtopResponseSchema>) {
  return payload.ret?.some((item) => /TOKEN|SESSION|ILLEGAL_ACCESS/i.test(item)) === true;
}

function isRetryableMtopFailure(payload: z.infer<typeof mtopResponseSchema>) {
  return payload.ret?.some((item) => /HSF_ASYNC_TIMEOUT|NETWORK|SYSTEM/i.test(item)) === true;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readMtopToken(context: BrowserContext) {
  const cookies = await context.cookies(mtopOrigin);
  const token = tokenFromCookieValue(
    cookies.find((cookie) => cookie.name === tokenCookieName)?.value ?? "",
  );
  if (!token) throw new Error("TAOBAO_MTOP_LOGIN_TOKEN_REQUIRED");
  return token;
}

async function requestMtop(
  context: BrowserContext,
  api: string,
  version: string,
  data: Record<string, unknown>,
) {
  let lastPayload: z.infer<typeof mtopResponseSchema> | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const request = createTaobaoMtopRequest({
      api,
      version,
      data,
      token: await readMtopToken(context),
      timestamp: Date.now(),
      callback: `mtopjsonp${attempt}`,
    });
    const response = await context.request.get(request.url, {
      headers: {
        accept: "*/*",
        referer: "https://creator.guanghe.taobao.com/",
      },
      timeout: 30_000,
    });
    if (!response.ok()) {
      throw new Error(`TAOBAO_MTOP_REQUEST_FAILED: status=${response.status()}`);
    }
    const payload = parseJsonp(await response.text());
    if (isSuccessfulMtopResponse(payload)) return payload.data;
    lastPayload = payload;
    if ((!isTokenFailure(payload) && !isRetryableMtopFailure(payload)) || attempt === 5) break;
    await wait(attempt * 1_000);
  }
  throw new Error(`TAOBAO_MTOP_REQUEST_REJECTED: ${JSON.stringify(lastPayload?.ret ?? [])}`);
}

export async function queryTaobaoCollectionList(
  context: BrowserContext,
  query: TaobaoCollectionListQuery = {},
): Promise<TaobaoCollectionListPage> {
  const pageNo = query.pageNo ?? 1;
  const pageSize = query.pageSize ?? 10;
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error("TAOBAO_COLLECTION_PAGE_NO_INVALID");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10) {
    throw new Error("TAOBAO_COLLECTION_PAGE_SIZE_INVALID");
  }
  const data = await requestMtop(context, collectionListApi, collectionListVersion, {
    bizCondition: JSON.stringify({
      typeList: query.typeList ?? [1, 3],
      keyword: query.keyword?.trim() ?? "",
      auditStatus: query.auditStatus ?? null,
    }),
    agentId: "",
    mode: 0,
    agentType: "matrix",
    source: "guanghe",
    pageNo,
    pageSize,
  });
  const model = z.object({ model: collectionListModelSchema }).passthrough().parse(data).model;
  if (model.pageIndex !== pageNo) {
    throw new Error(`TAOBAO_COLLECTION_PAGE_MISMATCH: expected=${pageNo} actual=${model.pageIndex}`);
  }
  return model;
}

export async function queryAllTaobaoCollections(
  context: BrowserContext,
  query: Omit<TaobaoCollectionListQuery, "pageNo"> = {},
) {
  const firstPage = await queryTaobaoCollectionList(context, { ...query, pageNo: 1 });
  const pages = [firstPage];
  for (let pageNo = 2; pageNo <= firstPage.pageCount; pageNo += 1) {
    await wait(500);
    pages.push(await queryTaobaoCollectionList(context, { ...query, pageNo }));
  }
  const data = pages.flatMap((page) => page.data);
  const uniqueIds = new Set(data.map((item) => String(item.collectionInfo.collectionId)));
  if (data.length !== firstPage.totalCount || uniqueIds.size !== firstPage.totalCount) {
    throw new Error(
      `TAOBAO_COLLECTION_TOTAL_MISMATCH: expected=${firstPage.totalCount} `
      + `actual=${data.length} unique=${uniqueIds.size}`,
    );
  }
  return {
    data,
    pageCount: firstPage.pageCount,
    totalCount: firstPage.totalCount,
  };
}
