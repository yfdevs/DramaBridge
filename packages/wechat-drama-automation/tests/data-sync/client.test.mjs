import assert from "node:assert/strict";
import test from "node:test";
import { DarenCenterClient } from "../../src/data-sync/client.ts";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status,
  });
}

void test("re-authenticates once and retries the original request after a 401", async () => {
  const calls = [];
  const responses = [
    jsonResponse({
      clientType: "B",
      data: {
        loginId: "client_demo",
        loginType: "admin",
        tokenName: "Authorization",
        tokenValue: "expired-token",
      },
      message: "登录成功",
      service: "rights-management-admin",
    }),
    jsonResponse(
      {
        clientType: "AUTH",
        data: null,
        message: "token 无效：expired-token",
        service: "gateway",
      },
      401,
    ),
    jsonResponse({
      clientType: "B",
      data: {
        loginId: "client_demo",
        loginType: "admin",
        tokenName: "Authorization",
        tokenValue: "refreshed-token",
      },
      message: "登录成功",
      service: "rights-management-admin",
    }),
    jsonResponse({
      clientType: "B",
      data: { username: "client_demo" },
      message: "请求成功",
      service: "rights-management-admin",
    }),
  ];

  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (input, init) => {
        calls.push({
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method,
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        });
        return responses.shift();
      },
    },
  );

  const result = await client.getCurrentUser();

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { username: "client_demo" });
  assert.deepEqual(
    calls.map(({ authorization, method }) => ({ authorization, method })),
    [
      { authorization: null, method: "POST" },
      { authorization: "expired-token", method: "GET" },
      { authorization: null, method: "POST" },
      { authorization: "refreshed-token", method: "GET" },
    ],
  );
});

void test("exposes the final HTTP status when the retried request still fails", async () => {
  let loginCount = 0;
  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          loginCount += 1;
          return jsonResponse({
            clientType: "B",
            data: {
              loginId: "client_demo",
              loginType: "admin",
              tokenName: "Authorization",
              tokenValue: `token-${loginCount}`,
            },
            message: "登录成功",
            service: "rights-management-admin",
          });
        }

        return jsonResponse(
          {
            clientType: "AUTH",
            data: null,
            message: "token 无效",
            service: "gateway",
          },
          401,
        );
      },
    },
  );

  await assert.rejects(client.getCurrentUser(), (error) => {
    assert.equal(error.name, "DarenCenterApiError");
    assert.equal(error.status, 401);
    assert.equal(error.response.clientType, "AUTH");
    return true;
  });
  assert.equal(loginCount, 2);
});

void test("uploads copyright data as multipart and retries it after a 401", async () => {
  const calls = [];
  let loginCount = 0;
  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (input, init) => {
        calls.push({ input, init });

        if (
          new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
            .pathname === "/api/b/auth/login"
        ) {
          loginCount += 1;
          return jsonResponse({
            clientType: "B",
            data: {
              loginId: "client_demo",
              loginType: "admin",
              tokenName: "Authorization",
              tokenValue: `upload-token-${loginCount}`,
            },
            message: "登录成功",
            service: "rights-management-admin",
          });
        }

        if (loginCount === 1) {
          return jsonResponse(
            {
              clientType: "AUTH",
              data: null,
              message: "token 无效",
              service: "gateway",
            },
            401,
          );
        }

        return jsonResponse({
          clientType: "B",
          data: { imported: true },
          message: "导入成功",
          service: "rights-management-admin",
        });
      },
    },
  );

  const file = new Blob(["workbook-content"], {
    type: "application/vnd.ms-excel",
  });
  const result = await client.importCopyrightData({
    file,
    filename: "模板.xls",
    sourceId: 46,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { imported: true });

  assert.equal(loginCount, 2);
  assert.equal(calls.length, 4);

  const uploadCall = calls[3];
  const headers = new Headers(uploadCall.init.headers);
  assert.equal(headers.get("authorization"), "upload-token-2");
  assert.equal(headers.has("content-type"), false);
  assert.equal(uploadCall.input.href, "http://example.test/api/b/copyright-data/import");
  assert.equal(uploadCall.init.method, "POST");
  assert.ok(uploadCall.init.body instanceof FormData);
  assert.equal(uploadCall.init.body.get("sourceId"), "46");

  const uploadedFile = uploadCall.init.body.get("files");
  assert.ok(uploadedFile instanceof Blob);
  assert.equal(uploadedFile.name, "模板.xls");
  assert.equal(uploadedFile.type, "application/vnd.ms-excel");
  assert.equal(await uploadedFile.text(), "workbook-content");

  const firstUploadBody = calls[1].init.body;
  assert.ok(firstUploadBody instanceof FormData);
  assert.equal(firstUploadBody.get("sourceId"), "46");
});

void test("uploads drama heating actions with authentication and a short filename", async () => {
  const calls = [];
  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        calls.push({ init, url });

        if (url.pathname === "/api/b/auth/login") {
          return jsonResponse({
            clientType: "B",
            data: {
              loginId: "client_demo",
              loginType: "admin",
              tokenName: "Authorization",
              tokenValue: "heating-token",
            },
            message: "登录成功",
            service: "rights-management-admin",
          });
        }

        return jsonResponse({
          clientType: "B",
          data: {
            receivedCount: 67,
            savedCount: 67,
          },
          message: "导入完成",
          service: "rights-management-admin",
        });
      },
    },
  );

  const result = await client.importDramaHeatingActions({
    file: new Blob(["account,date,amount\nexample,2026-08-12,1"], {
      type: "text/csv",
    }),
    filename: "加热平台标准看板_去码头整点漫剧_13109960320756515_2026-09-22_数据明细.csv",
  });

  assert.deepEqual(result.body.data, {
    receivedCount: 67,
    savedCount: 67,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/b/auth/login");
  assert.equal(calls[1].url.pathname, "/api/b/drama-heating/actions/import");
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "heating-token");
  assert.equal(new Headers(calls[1].init.headers).has("content-type"), false);
  assert.ok(calls[1].init.body instanceof FormData);

  const uploadedFile = calls[1].init.body.get("file");
  assert.ok(uploadedFile instanceof Blob);
  assert.equal(uploadedFile.name, "data.csv");
  assert.equal(uploadedFile.type, "text/csv");
  assert.equal(await uploadedFile.text(), "account,date,amount\nexample,2026-08-12,1");
});

void test("ingests the inner WeChat drama statistics payload without authentication", async () => {
  const calls = [];
  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        calls.push({ init, url });

        return jsonResponse({
          clientType: "B",
          data: {
            receivedCount: 899,
            reportedTotalCount: 899,
            savedCount: 899,
          },
          message: "导入完成",
          service: "rights-management-admin",
        });
      },
    },
  );
  const statistics = {
    baseResp: { errcode: 0, errmsg: "ok" },
    list: [{ dramaInfo: { dramaUuid: "drama-1" } }],
    statisticTime: "2026-09-07",
    totalCount: 1,
    wechatVideoAccountName: "视频号测试账号",
  };

  const result = await client.ingestWeChatDramaStatistics(statistics);

  assert.equal(result.body.data.savedCount, 899);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/b/wechat-drama/statistics/ingest");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
  assert.equal(
    new Headers(calls[0].init.headers).get("content-type"),
    "application/json;charset=UTF-8",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), statistics);
});

void test("finds a source ID by exact name across filtered pages", async () => {
  const requestedUrls = [];
  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (input) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        requestedUrls.push(url);

        if (url.pathname === "/api/b/auth/login") {
          return jsonResponse({
            clientType: "B",
            data: {
              loginId: "client_demo",
              loginType: "admin",
              tokenName: "Authorization",
              tokenValue: "source-token",
            },
            message: "登录成功",
            service: "rights-management-admin",
          });
        }

        const page = Number(url.searchParams.get("page"));
        return jsonResponse({
          clientType: "B",
          data: {
            page,
            records:
              page === 1 ? [{ id: 45, name: "目标来源扩展" }] : [{ id: 46, name: "目标来源" }],
            size: 1,
            total: 2,
          },
          message: "请求成功",
          service: "rights-management-admin",
        });
      },
    },
  );

  assert.equal(await client.getSourceId(" 目标来源 "), 46);
  assert.equal(requestedUrls[1].searchParams.get("keyword"), "目标来源");
  assert.equal(requestedUrls[1].searchParams.get("page"), "1");
  assert.equal(requestedUrls[2].searchParams.get("page"), "2");
});

void test("throws a specific error when a data source cannot be found", async () => {
  const client = new DarenCenterClient(
    {
      baseUrl: "http://example.test",
      password: "password",
      timeoutMs: 30_000,
      username: "client_demo",
    },
    {
      fetch: async (input) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );

        if (url.pathname === "/api/b/auth/login") {
          return jsonResponse({
            clientType: "B",
            data: {
              loginId: "client_demo",
              loginType: "admin",
              tokenName: "Authorization",
              tokenValue: "source-token",
            },
            message: "登录成功",
            service: "rights-management-admin",
          });
        }

        return jsonResponse({
          clientType: "B",
          data: {
            page: 1,
            records: [],
            size: 100,
            total: 0,
          },
          message: "请求成功",
          service: "rights-management-admin",
        });
      },
    },
  );

  await assert.rejects(client.getSourceId("不存在的来源"), (error) => {
    assert.equal(error.name, "DarenCenterDataSourceNotFoundError");
    assert.equal(error.sourceName, "不存在的来源");
    return true;
  });
});
