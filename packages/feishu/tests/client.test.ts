import assert from "node:assert/strict";
import test from "node:test";
import { FeishuClient, FeishuTables, columnName, cellText, type TableSnapshot } from "../src/index.js";

test("transient token DNS failure recovers with one shared bounded retry", async () => {
  let auth = 0;
  const client = new FeishuClient({ appId: "test", appSecret: "secret" }, (async (url) => {
    if (String(url).includes("oauth/v3/token")) {
      if (++auth === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("DNS"), { code: "ENOTFOUND" }) });
      return Response.json({ access_token: "token", expires_in: 7200 });
    }
    return Response.json({ data: { ok: true } });
  }) as typeof fetch);
  await Promise.all([client.request("/test"), client.request("/test")]);
  assert.equal(auth, 2);
});

test("persistent DNS failure is bounded and a later call can obtain a token", async () => {
  let auth = 0, offline = true;
  const client = new FeishuClient({ appId: "test", appSecret: "secret" }, (async (url) => {
    if (String(url).includes("oauth/v3/token")) {
      auth++;
      if (offline) throw new TypeError("fetch failed", { cause: Object.assign(new Error("DNS"), { code: "ENOTFOUND" }) });
      return Response.json({ access_token: "token", expires_in: 7200 });
    }
    return Response.json({ data: {} });
  }) as typeof fetch);
  await assert.rejects(client.request("/test"), /飞书网络连接失败.*ENOTFOUND/);
  assert.equal(auth, 3);
  offline = false;
  await client.request("/test");
  assert.equal(auth, 4);
});

test("uncertain table writes are never replayed after a connection reset", async () => {
  let writes = 0;
  const client = new FeishuClient({ appId: "test", appSecret: "secret" }, (async (url) => {
    if (String(url).includes("oauth/v3/token")) return Response.json({ access_token: "token", expires_in: 7200 });
    writes++;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  }) as typeof fetch);
  await assert.rejects(client.request("/test", "POST", {}), /飞书网络连接失败/);
  assert.equal(writes, 1);
});

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

test("projects source columns in one batch, handles reversed results and preserves absolute row numbers", async () => {
  let active = 0, peak = 0;
  const ranges: string[] = [];
  const client = { request: async (url: string) => {
    if (url.includes("sheets/query")) return { sheets: [{ sheet_id: "source", title: "拼多多-新剧", grid_properties: { row_count: 1002, column_count: 6 } }] };
    if (url.includes("/values/")) return { valueRange: { values: [["其他", "剧名", "备注", "其他2", "其他3", "网盘（拼多多）"]] } };
    const batch = new URL(`https://example.com${url}`).searchParams.get("ranges")!.split(",");
    ranges.push(...batch);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { valueRanges: batch.reverse().map(range => {
      const [, column, start, end] = range.match(/!([BF])(\d+):[BF](\d+)/)!;
      return { range, values: Array.from({ length: Number(end) - Number(start) + 1 }, (_, i) => [`${column}-${Number(start) + i}`]) };
    }) };
  } } as unknown as FeishuClient;
  const result = await new FeishuTables(client).read("https://example.feishu.cn/sheets/source", "拼多多-新剧", { columns: ["剧名", "网盘（拼多多）"] });
  assert.equal(peak, 1);
  assert.equal(ranges.length, 4);
  assert.deepEqual(result.rows.find(row => row.number === 1002)?.values.filter(Boolean), ["B-1002", "F-1002"]);
  assert.ok(ranges.every(range => /!B|!F/.test(range)));
  assert.equal(result.rows[0].values[2], undefined);
});

test("full table chunk reads overlap at most three requests and preserve row order", async () => {
  let active = 0, peak = 0;
  const client = { request: async (url: string) => {
    if (url.includes("sheets/query")) return { sheets: [{ sheet_id: "s", title: "表", grid_properties: { row_count: 3001, column_count: 1 } }] };
    const row = Number(decodeURIComponent(url).match(/!A(\d+):/)![1]);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, row === 1 ? 10 : 1)); active--;
    return { valueRange: { values: [[String(row)]] } };
  } } as unknown as FeishuClient;
  const table = await new FeishuTables(client).read("https://example.feishu.cn/sheets/s", "表");
  assert.equal(peak, 3);
  assert.equal(table.rows.find(row => row.number === 1001)?.values[0], "1001");
  assert.equal(table.rows.find(row => row.number === 3001)?.values[0], "3001");
});

test("selects supplemental sheet by ID even when its title changes", async () => {
  const tables = new FeishuTables({ request: async (url: string) => {
    if (url.includes("sheets/query")) return { sheets: [
      { sheet_id: "old", title: "拼多多-新剧", grid_properties: { row_count: 2, column_count: 2 } },
      { sheet_id: "QeuDEm", title: "更名后的资源表", grid_properties: { row_count: 2, column_count: 2 } },
    ] };
    if (url.includes("/values/")) return { valueRange: { values: [["剧名", "全集链接"]] } };
    const range = new URL(`https://example.com${url}`).searchParams.get("ranges")!;
    assert.equal(range, "QeuDEm!A2:B2");
    return { valueRanges: [{ range, values: [["剧", "https://pan.baidu.com/s/full"]] }] };
  } } as unknown as FeishuClient);
  const result = await tables.read("https://example.feishu.cn/sheets/source", "拼多多-新剧", { sheetId: "QeuDEm", columns: ["剧名", "全集链接"] });
  assert.equal(result.sheet.sheet_id, "QeuDEm");
  assert.equal(result.rows[0].values[1], "https://pan.baidu.com/s/full");
});

test("batch writes merge adjacent cells without overwriting unrelated columns and split large requests", async () => {
  const bodies: { valueRanges: { range: string; values: string[][] }[] }[] = [];
  const tables = new FeishuTables({ request: async (_url: string, _method: string, data: typeof bodies[number]) => { bodies.push(data); } } as unknown as FeishuClient);
  const snapshot = { spreadsheet: "s", sheet: { sheet_id: "tasks" } } as TableSnapshot;
  await tables.writeRows(snapshot, Array.from({ length: 205 }, (_, i) => ({ row: i + 2, cells: [{ column: 0, value: "剧名" }, { column: 1, value: "90" }, { column: 3, value: "链接" }] })));
  assert.equal(bodies.length, 5);
  assert.ok(bodies.every(body => body.valueRanges.length <= 100));
  assert.deepEqual(bodies[0].valueRanges.slice(0, 2), [{ range: "tasks!A2:B2", values: [["剧名", "90"]] }, { range: "tasks!D2:D2", values: [["链接"]] }]);
});
