import { z } from "zod";
import type { BrowserContext } from "playwright";

const douyinBookListEndpoint = "https://www.shortdramas.com/api/playlet/book/list/v1";
const douyinBookManageUrl =
  "https://www.shortdramas.com/page/copyright/book-manage?tab=motion_comic";

const recordSchema = z.record(z.string(), z.unknown());
const responseSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

export type DouyinBookListItem = Record<string, unknown>;

export function createDouyinBookListUrl(title: string) {
  const query = new URLSearchParams({
    role_type: "3",
    author_type: "1",
    member_type: "3",
    term: "{}",
    match: JSON.stringify({ book_name: title.trim() }),
    terms: "{}",
    search_after: "",
    genre: "15",
    page_index: "0",
    page_size: "20",
    sort_type: "",
    sort_field: "",
    need_export: "0",
    aid: "791322",
    app_name: "novel_produce_platform",
  });
  return `${douyinBookListEndpoint}?${query}`;
}

function nestedRecord(value: unknown, keys: string[]) {
  let current: unknown = value;
  for (const key of keys) {
    const parsed = recordSchema.safeParse(current);
    if (!parsed.success) return undefined;
    current = parsed.data[key];
  }
  return current;
}

function bookItemsFromPayload(payload: z.infer<typeof responseSchema>) {
  const candidates = [
    payload.data,
    nestedRecord(payload.data, ["data"]),
    nestedRecord(payload.data, ["list"]),
    nestedRecord(payload.data, ["book_list"]),
    nestedRecord(payload.data, ["bookList"]),
    nestedRecord(payload.data, ["records"]),
    nestedRecord(payload.data, ["items"]),
    nestedRecord(payload.data, ["result"]),
  ];
  for (const candidate of candidates) {
    const parsed = z.array(recordSchema).safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  throw new Error("DOUYIN_DRAMA_BOOK_LIST_RESPONSE_INVALID: list missing");
}

function textField(record: DouyinBookListItem, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function douyinBookTitle(item: DouyinBookListItem) {
  const direct = textField(item, ["book_name", "bookName", "name", "title"]);
  if (direct) return direct;
  for (const key of ["content", "book", "book_info", "bookInfo"]) {
    const nested = recordSchema.safeParse(item[key]);
    if (!nested.success) continue;
    const title = textField(nested.data, ["book_name", "bookName", "name", "title"]);
    if (title) return title;
  }
  return undefined;
}

export function findExistingDouyinBook(items: DouyinBookListItem[], title: string) {
  const expected = title.trim();
  if (!expected) return undefined;
  return items.find((item) => douyinBookTitle(item) === expected);
}

function bookIdentifier(item: DouyinBookListItem) {
  for (const record of [
    item,
    ...["content", "book", "book_info", "bookInfo"]
      .map((key) => recordSchema.safeParse(item[key]))
      .filter((result) => result.success)
      .map((result) => result.data),
  ]) {
    for (const key of ["book_id", "bookId", "id"]) {
      const value = record[key];
      if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
        return String(value).trim();
      }
    }
  }
  return undefined;
}

function isSuccessCode(code: string | number | undefined) {
  return code === undefined || code === 0 || code === "0";
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function queryDouyinBookByTitle(context: BrowserContext, title: string) {
  const keyword = title.trim();
  if (!keyword) throw new Error("DOUYIN_DRAMA_BOOK_TITLE_REQUIRED");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await context.request.get(createDouyinBookListUrl(keyword), {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "agw-js-conv": "str",
          "playlet-author-type": "1",
          "playlet-role-type": "3",
          referer: douyinBookManageUrl,
        },
        timeout: 30_000,
      });
      if (!response.ok()) {
        throw new Error(`DOUYIN_DRAMA_BOOK_LIST_REQUEST_FAILED: status=${response.status()}`);
      }
      const payload = responseSchema.parse(await response.json());
      if (!isSuccessCode(payload.code)) {
        throw new Error(
          `DOUYIN_DRAMA_BOOK_LIST_REQUEST_REJECTED: code=${payload.code} `
          + `message=${payload.message ?? payload.msg ?? "-"}`,
        );
      }
      const items = bookItemsFromPayload(payload);
      const book = findExistingDouyinBook(items, keyword);
      return {
        book,
        bookId: book ? bookIdentifier(book) : undefined,
        matchedCount: items.length,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(attempt * 1_000);
    }
  }
  throw lastError;
}
