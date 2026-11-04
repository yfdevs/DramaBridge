import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { claimNextTaskForVideoAccountApi, reportClaimedTaskSuccessApi, reportClaimedTaskErrorApi } from "../../src/api/task.js";
import { configureWechatReportStore, flushWechatTaskReports, type WechatPendingReport } from "../../src/api/task-reports.js";
import { configureWechatVideoRuntimeSettings } from "../../src/shared/runtime-settings.js";
import { fetchVideoAccountsApi } from "../../src/api/video-accounts.js";

async function fixture(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(handler(request.url!, JSON.parse(body))));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  configureWechatVideoRuntimeSettings({ apiBaseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}` });
  let pending: WechatPendingReport[] = [];
  configureWechatReportStore({ load: () => pending, save: value => { pending = value; } });
  return { pending: () => pending, close: () => server.close() };
}

test("claims and reports with the exact execution identity, retaining failed callbacks", async () => {
  const reports: Record<string, unknown>[] = []; let failReport = true; let workerId = "";
  const f = await fixture((url, body) => {
    if (url.endsWith('/accountTask/page')) return { code: 0, data: { total: 1, data: [{ id: 22, videoAccountId: 'a', rpaStatus: 'READY' }] } };
    if (url.endsWith('/claim')) { workerId = String(body.workerId); return { code: 0, data: { accountTaskId: 22, workerId, attemptCount: 3, originalTitle: '测试剧', payloadJson: {} } }; }
    assert.equal(url, '/dramaAiRpa/rpa/report'); reports.push(body);
    return failReport ? { code: 500, msg: '暂时不可用' } : { code: 0 };
  });
  try {
    const task = await claimNextTaskForVideoAccountApi({ id: 'a', name: '账号' });
    assert.ok(task); assert.ok(workerId); assert.equal(task.attemptCount, 3);
    await reportClaimedTaskSuccessApi(task);
    assert.equal(f.pending().length, 1);
    assert.equal(reports[0].rpaStatus, 'SUCCESS'); assert.equal(reports[0].workerId, workerId);
    assert.equal(reports[0].attemptCount, 3);
    failReport = false; await flushWechatTaskReports(); assert.equal(f.pending().length, 0);
    await reportClaimedTaskErrorApi({ ...task, failStage: 'OTHER', errorMessage: '测试错误' });
    assert.equal(reports.at(-1)?.rpaStatus, 'FAILED');
  } finally { f.close(); }
});

test("rejects an ownership mismatch before executing the task", async () => {
  const f = await fixture(url => url.endsWith('/page') ? { code: 0, data: { total: 1, data: [{ id: 22, videoAccountId: 'a' }] } } :
    { code: 0, data: { accountTaskId: 22, workerId: 'another-computer', attemptCount: 1, originalTitle: '剧', payloadJson: {} } });
  try { await assert.rejects(claimNextTaskForVideoAccountApi({ id: 'a', name: '账号' }), /CLAIM_IDENTITY_INVALID/); }
  finally { f.close(); }
});

test("loads every account with 100 records per page", async () => {
  const pages: number[] = [];
  const f = await fixture((_url, body) => {
    assert.equal(body.pageSize, 100); pages.push(Number(body.page));
    const offset = (Number(body.page) - 1) * 100;
    return { code: 0, data: { total: 205, data: Array.from({ length: Math.min(100, 205 - offset) }, (_, index) => ({ videoAccountId: `a${offset + index}`, videoAccountName: `账号${offset + index}` })) } };
  });
  try { const accounts = await fetchVideoAccountsApi(); assert.equal(accounts.length, 205); assert.deepEqual(pages, [1, 2, 3]); }
  finally { f.close(); }
});
