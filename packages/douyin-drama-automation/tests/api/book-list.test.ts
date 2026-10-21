import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import {
  createDouyinBookListUrl,
  douyinBookTitle,
  findExistingDouyinBook,
  queryDouyinBookByTitle,
} from "../../src/api/book-list.js";

test("creates the Douyin book search request with an exact title keyword", () => {
  const url = new URL(createDouyinBookListUrl(" 几万斤鱼换他倾家荡产 "));
  assert.equal(url.origin, "https://www.shortdramas.com");
  assert.equal(url.pathname, "/api/playlet/book/list/v1");
  assert.equal(url.searchParams.get("genre"), "15");
  assert.deepEqual(JSON.parse(url.searchParams.get("match") ?? ""), {
    book_name: "几万斤鱼换他倾家荡产",
  });
});

test("only reuses a book whose title is an exact trimmed match", () => {
  const books = [
    { book_id: "1", book_name: "几万斤鱼换他倾家荡产续集" },
    { book_id: "2", book_name: " 几万斤鱼换他倾家荡产 " },
  ];
  assert.equal(findExistingDouyinBook(books, "几万斤鱼换他倾家荡产")?.book_id, "2");
  assert.equal(findExistingDouyinBook(books, "几万斤鱼换他倾家"), undefined);
});

test("reads a title from supported direct and nested book fields", () => {
  assert.equal(douyinBookTitle({ bookName: "直接标题" }), "直接标题");
  assert.equal(douyinBookTitle({ book_info: { book_name: "嵌套标题" } }), "嵌套标题");
  assert.equal(
    douyinBookTitle({
      id: "7698965920550489113",
      content: { book_id: "7698965920550489113", book_name: "接口真实标题" },
    }),
    "接口真实标题",
  );
});

test("parses the nested content shape returned by the real Douyin book API", async () => {
  let requestedUrl = "";
  const context = {
    request: {
      get: async (url: string) => {
        requestedUrl = url;
        return {
          ok: () => true,
          status: () => 200,
          json: async () => ({
            code: 0,
            data: {
              list: [{
                id: "7698965920550489113",
                content: {
                  book_id: "7698965920550489113",
                  book_name: "几万斤鱼换他倾家荡产",
                },
              }],
              total: 1,
            },
            message: "success",
          }),
        };
      },
    },
  } as unknown as BrowserContext;

  const result = await queryDouyinBookByTitle(context, "几万斤鱼换他倾家荡产");
  assert.equal(result.bookId, "7698965920550489113");
  assert.equal(result.matchedCount, 1);
  assert.equal(new URL(requestedUrl).searchParams.get("genre"), "15");
});
