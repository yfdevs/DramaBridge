import assert from "node:assert/strict";
import test from "node:test";
import { FeishuClient, FeishuTables, columnName, cellText } from "../src/index.js";

test("shares one token request, caches expiry, and never puts credentials in API URLs", async () => {
  let auth = 0;
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("oauth/v3/token")) {
      auth++;
      assert.equal(JSON.parse(String(init?.body)).client_secret, "test-secret");
      return Response.json({ access_token: "token", expires_in: 7200 });
    }
    assert.ok(!String(url).includes("test-secret"));
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer token");
    return Response.json({ code: 0, data: { ok: true } });
  }) as typeof fetch;
  const client = new FeishuClient({ appId: "cli_test", appSecret: "test-secret" }, transport);
  await Promise.all([client.request("/test"), client.request("/test")]);
  await client.request("/test");
  assert.equal(auth, 1);
});

test("resolves wiki sheets, reads all chunks and writes only selected cells/styles", async () => {
  const writes: { path: string; data: unknown }[] = [];
  const client = {
    request: async (path: string, method = "GET", data?: unknown) => {
      if (method !== "GET") {
        writes.push({ path, data });
        return {};
      }
      if (path.includes("get_node"))
        return { node: { obj_type: "sheet", obj_token: "spreadsheet" } };
      if (path.includes("sheets/query"))
        return {
          sheets: [
            {
              sheet_id: "sheet",
              title: "快手二创",
              grid_properties: { row_count: 1002, column_count: 3 },
            },
          ],
        };
      const range = decodeURIComponent(path);
      return {
        valueRange: {
          values: range.includes("A1:")
            ? [
                ["剧名", "集数", "链接"],
                ["第一部", 80, "a"],
              ]
            : [["最后一部", 90, "b"]],
        },
      };
    },
  } as unknown as FeishuClient;
  const tables = new FeishuTables(client);
  const snapshot = await tables.read("https://example.feishu.cn/wiki/node", "快手二创");
  assert.equal(snapshot.rows.find((row) => row.number === 1001)?.values[0], "最后一部");
  await tables.writeCells(snapshot, 1001, [{ column: 2, value: "result" }]);
  await tables.markError(snapshot, 1001, 2, true);
  assert.deepEqual(writes[0].data, {
    valueRanges: [{ range: "sheet!C1001:C1001", values: [["result"]] }],
  });
  assert.match(JSON.stringify(writes[1].data), /#FEE2E2/);
  assert.equal(columnName(26), "AA");
  assert.equal(cellText({ text: "网盘素材", link: "https://pan.baidu.com/s/1test" }), "https://pan.baidu.com/s/1test");
  await assert.rejects(tables.resolve("https://evil.example/wiki/node"), /飞书/);
});
