import type { Page, Response } from "playwright";
import type { WeiboPublishAccount } from "./browser-session.js";

export type WeiboCollection = {
  id: number | string;
  name: string;
  pub_uid: number | string;
  status: number;
  total_num: number;
};
export type WeiboCollectionInfo = {
  detail_info: WeiboCollection;
  video_list: Array<{ status: number; index_num: number }>;
};

export function assertWeiboCollectionHasNoDuplicates(info: WeiboCollectionInfo, count: number) {
  const indexes = info.video_list.map((video) => Number(video.index_num));
  if (indexes.length > count || new Set(indexes).size !== indexes.length)
    throw new Error(
      `WEIBO_DRAMA_COLLECTION_DUPLICATE: 合集 ${info.detail_info.id} 后台已有${indexes.length}/${count}集，存在重复或超量视频，请在微博人工处理；已停止上传和提交`,
    );
}

export function assertWeiboCollectionCanSubmit(
  info: WeiboCollectionInfo,
  albumId: string,
  title: string,
  accountId: string,
  count: number,
) {
  if (String(info.detail_info.id) !== albumId || info.detail_info.name !== title ||
      String(info.detail_info.pub_uid) !== accountId || Number(info.detail_info.total_num) !== count)
    throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 提交前合集身份或总集数不匹配");
  assertWeiboCollectionHasNoDuplicates(info, count);
  if (![0, -1, -2].includes(Number(info.detail_info.status)) ||
      info.video_list.some((video) => [1, 2, 6].includes(Number(video.status))))
    throw new Error("WEIBO_DRAMA_COLLECTION_ALREADY_SUBMITTED: 后台已有审核中或已上线内容，已阻止再次提交，请刷新并核对合集");
}

async function read<T>(page: Page, endpoint: string): Promise<T> {
  return page.evaluate(async (endpoint) => {
    const token = localStorage.getItem("token");
    const response = await fetch(`https://api-duanju.weibo.com${endpoint}`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok || result.status !== 0 || !result.data)
      throw new Error(`WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: ${result.msg ?? response.status}`);
    return result.data;
  }, endpoint);
}

export async function findExistingWeiboCollection(page: Page, title: string, accountId: string) {
  const matches = new Map<string, WeiboCollection>();
  for (let current = 1; ; current++) {
    const query = new URLSearchParams({
      pub_uid: accountId,
      keyword: title,
      page: String(current),
      page_size: "10",
      status: "",
    });
    const data = await read<{ list: WeiboCollection[]; total: number }>(
      page,
      `/creator/album/list?${query}`,
    );
    if (!Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0)
      throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 合集列表返回格式异常");
    for (const item of data.list) {
      if (item.name === title && String(item.pub_uid) === accountId) {
        if (!item.id) throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 合集ID缺失");
        matches.set(String(item.id), item);
      }
    }
    if (current * 10 >= data.total) break;
    if (!data.list.length || current >= 1000)
      throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 合集列表分页异常");
  }
  if (matches.size > 1)
    throw new Error(
      "WEIBO_DRAMA_COLLECTION_AMBIGUOUS: 当前发布账号存在多个同名合集，请人工确认后重试",
    );
  return [...matches.values()][0];
}

export async function readWeiboCollectionInfo(
  page: Page,
  id: string,
): Promise<WeiboCollectionInfo> {
  const data = await read<WeiboCollectionInfo>(
    page,
    `/creator/album/info?id=${encodeURIComponent(id)}`,
  );
  if (!data.detail_info || !Array.isArray(data.video_list))
    throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 合集详情返回格式异常");
  return data;
}

export function isWeiboCollectionComplete(
  info: WeiboCollectionInfo,
  title: string,
  accountId: string,
  count: number,
) {
  return (
    info.detail_info.name === title &&
    String(info.detail_info.pub_uid) === accountId &&
    Number(info.detail_info.total_num) === count &&
    [1, 2, 6].includes(Number(info.detail_info.status)) &&
    info.video_list.length === count &&
    info.video_list.every((video) => [2, 6].includes(Number(video.status))) &&
    info.video_list
      .map((video) => Number(video.index_num))
      .sort((a, b) => a - b)
      .every((value, index) => value === index + 1)
  );
}

export async function openExistingWeiboCollection(
  page: Page,
  collection: WeiboCollection,
  account: WeiboPublishAccount,
) {
  async function waitForListRender(response: Response) {
    const result = await response.json();
    if (!response.ok() || result.status !== 0 || !Array.isArray(result.data?.list))
      throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 合集列表加载失败");
    await page.waitForFunction(
      (names: string[]) =>
        JSON.stringify(
          [...document.querySelectorAll(".el-table__body .series-title")].map((node) =>
            node.textContent?.trim(),
          ),
        ) === JSON.stringify(names),
      result.data.list.map((item: WeiboCollection) => item.name),
    );
  }
  const initial = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/creator/album/list",
  );
  await page.goto("https://duanju.mcn.weibo.com/content/series", { waitUntil: "domcontentloaded" });
  await waitForListRender(await initial);
  const search = page.getByPlaceholder("搜索合集名称");
  await search.waitFor();
  await page.locator(".account-select .el-select__wrapper").first().click();
  const filteredAccount = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/creator/album/list" &&
      url.searchParams.get("pub_uid") === account.uid &&
      url.searchParams.get("keyword") === ""
    );
  });
  await page
    .locator(".el-select__popper:visible")
    .getByRole("option", { name: account.name, exact: true })
    .click();
  // Wait before searching: otherwise the slower account-filter response can
  // overwrite the keyword response with an unfiltered table.
  await waitForListRender(await filteredAccount);
  const loaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/creator/album/list" &&
      url.searchParams.get("keyword") === collection.name &&
      url.searchParams.get("pub_uid") === account.uid
    );
  });
  await search.fill(collection.name);
  await search.blur();
  await waitForListRender(await loaded);
  const row = page.locator(".el-table__body .el-table__row").filter({
    has: page.getByText(collection.name, { exact: true }),
  });
  // A keyword search may include similarly named collections on earlier pages.
  while (!(await row.count())) {
    const next = page.getByRole("button", { name: "下一页", exact: true });
    if (await next.isDisabled())
      throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 列表中未找到目标合集");
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/creator/album/list",
    );
    await next.click();
    await waitForListRender(await response);
  }
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === "/content/series/publish" &&
        url.searchParams.get("album_id") === String(collection.id),
    ),
    row.getByText("编辑", { exact: true }).click(),
  ]);
  await page.waitForFunction(
    (title) => document.querySelector<HTMLInputElement>(".el-form-item input")?.value === title,
    collection.name,
  );
}
