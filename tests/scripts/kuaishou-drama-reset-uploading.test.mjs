import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseResetArgs, resetKuaishouTasks, resetEligibility, loginResetAdmin, createResetApi } from "../../scripts/kuaishou-drama-reset-uploading.mjs";

const now = Date.parse("2026-10-31T12:00:00+08:00");
const task = (patch = {}) => ({ id: 1500, platform: "KUAISHOU", accountId: "account-1", status: "UPLOADING",
  originalTitle: "原剧名", rpaWorkerId: "old-worker", rpaAttemptCount: 1,
  rpaClaimTime: "2026-10-31T01:00:00", updateTime: "2026-10-31T01:00:00", ...patch });
const args = (...extra) => parseResetArgs(["--account-id", "account-1", "--ids", "1500", ...extra]);
const apply = (...extra) => args("--apply", "--confirm-stopped", ...extra);

function server(rows = [task()]) {
  const calls = [];
  const api = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint === "/accountTask/page") return { total: rows.length, data: structuredClone(rows.filter(row => !body.status || row.status === body.status)) };
    const row = rows.find(row => row.id === (body?.taskId ?? Number(endpoint.split("/").at(-1))));
    if (endpoint === "/rpa/report") {
      assert.equal(row.rpaWorkerId, body.workerId); assert.equal(row.rpaAttemptCount, body.attemptCount);
      assert.equal(body.success, false); assert.match(body.errorMessage, /人工重置/);
      row.status = "FAILED"; return true;
    }
    assert.match(endpoint, /^\/accountTask\/retry\/\d+$/);
    assert.equal(row.status, "FAILED"); row.status = "READY"; return true;
  };
  return { api, calls, rows };
}

test("dry-run preview does not mutate any task", async () => {
  const backend = server();
  const result = await resetKuaishouTasks(args("--dry-run"), { api: backend.api, now });
  assert.equal(result.tasks[0].action, "eligible");
  assert.ok(backend.calls.every(call => call.endpoint.endsWith("/page")));
  assert.equal(backend.rows[0].status, "UPLOADING");
});

test("one-click execution defaults to four hours and accepts skip lists without confirmation flags", () => {
  const options = parseResetArgs(["--skip-ids", "1498", "--skip", "1497,1498"]);
  assert.equal(options.apply, true); assert.equal(options.minAgeHours, 4);
  assert.deepEqual(options.skipIds, [1498, 1497]);
  for (const invalid of ["", "1,2x", "-1", "1.5"]) assert.throws(() => parseResetArgs(["--ids", invalid]));
  assert.throws(() => parseResetArgs(["--claimed-before", "invalid"]));
  assert.throws(() => parseResetArgs(["--older-than-hours", "-1"]));
});

test("only stale selected tasks are reset, with original claim identity and an audit checkpoint before each write", async () => {
  const backend = server([task(), task({ id: 1498, rpaWorkerId: "active-worker", rpaClaimTime: "2026-10-31T11:44:26" })]);
  const checkpoints = [];
  const result = await resetKuaishouTasks(apply(), { api: backend.api, now, checkpoint: async journal => checkpoints.push(structuredClone(journal)) });
  assert.equal(result.tasks[0].action, "reset");
  assert.equal(backend.rows[0].status, "READY"); assert.equal(backend.rows[1].status, "UPLOADING");
  assert.deepEqual(backend.calls.filter(call => !call.endpoint.endsWith("/page")).map(call => call.endpoint), ["/rpa/report", "/accountTask/retry/1500"]);
  assert.ok(checkpoints.some(journal => journal.tasks[0].action === "reporting-interruption"));
  assert.ok(checkpoints.some(journal => journal.tasks[0].action === "retrying"));
});

test("other accounts, successful tasks and missing ownership cannot be reset", () => {
  for (const patch of [{ accountId: "other" }, { status: "COMPLETED" }, { rpaWorkerId: "" }, { rpaAttemptCount: undefined }, { rpaClaimTime: "invalid" }, { platform: "TAOBAO" }]) assert.ok(resetEligibility(task(patch), apply(), now));
});

test("a changed worker/round is skipped immediately before mutation", async () => {
  const backend = server(); let reads = 0;
  const api = async (endpoint, body) => {
    if (endpoint.endsWith("/page") && ++reads === 3) backend.rows[0].rpaAttemptCount = 2;
    return backend.api(endpoint, body);
  };
  const result = await resetKuaishouTasks(apply(), { api, now });
  assert.equal(result.tasks[0].action, "skipped");
  assert.ok(backend.calls.every(call => call.endpoint.endsWith("/page")));
});

test("an unacknowledged report never triggers retry", async () => {
  const backend = server();
  const api = async (endpoint, body) => endpoint === "/rpa/report" ? false : backend.api(endpoint, body);
  await assert.rejects(resetKuaishouTasks(apply(), { api, now }), /禁止继续重试/);
  assert.ok(backend.calls.every(call => call.endpoint.endsWith("/page")));
});

test("interrupted reset resumes FAILED tasks without reporting a second failure", async () => {
  const backend = server([task({ status: "FAILED" })]);
  const result = await resetKuaishouTasks(apply("--resume-failed"), { api: backend.api, now });
  assert.equal(result.tasks[0].action, "reset");
  assert.ok(!backend.calls.some(call => call.endpoint === "/rpa/report"));
});

test("a task reclaimed immediately after retry counts as reset, without overwriting its new owner", async () => {
  const backend = server();
  const api = async (endpoint, body) => {
    const result = await backend.api(endpoint, body);
    if (endpoint.startsWith("/accountTask/retry/")) Object.assign(backend.rows[0], { status: "UPLOADING", rpaAttemptCount: 2, rpaWorkerId: "new-worker" });
    return result;
  };
  const result = await resetKuaishouTasks(apply(), { api, now });
  assert.equal(result.tasks[0].action, "reset");
  assert.equal(result.tasks[0].resultStatus, "UPLOADING");
  assert.equal(backend.rows[0].rpaWorkerId, "new-worker");
});

test("bulk selection uses Beijing claim times and defaults to a four-hour threshold", async () => {
  const backend = server([task(), task({ id: 1498, rpaClaimTime: "2026-10-31T11:44:26" }), task({ id: 1497, rpaClaimTime: "2026-10-31T09:00:00", updateTime: "2026-10-31T09:00:00" })]);
  const result = await resetKuaishouTasks(parseResetArgs(["--skip-ids", "1498"]), { api: backend.api, now });
  assert.equal(result.tasks.find(row => row.id === 1500).action, "reset");
  assert.equal(result.tasks.find(row => row.id === 1498).reason, "在跳过列表中");
  assert.match(result.tasks.find(row => row.id === 1497).reason, /最短时长/);
});

test("explicit IDs override default age, but explicit time filters still apply and skip always wins", () => {
  const recent = task({ rpaClaimTime: "2026-10-31T11:00:00", updateTime: "2026-10-31T11:00:00" });
  assert.equal(resetEligibility(recent, args(), now), null);
  assert.match(resetEligibility(recent, args("--older-than-hours", "4"), now), /最短时长/);
  assert.equal(resetEligibility(recent, args("--skip-ids", "1500"), now), "在跳过列表中");
  assert.match(resetEligibility(recent, args("--claimed-before", "2026-10-31T06:00:00"), now), /指定领取时间/);
});

test("bulk reset recovers its own interrupted failures without resetting unrelated FAILED tasks", async () => {
  const backend = server([task({ status: "FAILED", lastErrorMessage: "人工重置已中断的快手执行任务；待重试" }), task({ id: 1501, status: "FAILED", lastErrorMessage: "正常上传失败" })]);
  const result = await resetKuaishouTasks(parseResetArgs([]), { api: backend.api, now });
  assert.equal(result.tasks.length, 1); assert.equal(result.tasks[0].action, "reset");
  assert.equal(backend.rows[1].status, "FAILED");
});

test("authentication is established before mutation and uses the token header returned by the server", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/user/login")) return { ok: true, json: async () => ({ code: 0, data: { tokenName: "satoken", tokenValue: "test-session" } }) };
    assert.equal(options.headers.satoken, "test-session");
    return { ok: true, json: async () => ({ code: 0, data: true }) };
  };
  const authentication = await loginResetAdmin("http://backend.test", { username: "admin", password: "test-password" }, fetcher);
  const api = createResetApi("http://backend.test", fetcher, authentication);
  await api("/accountTask/retry/1500");
  assert.equal(api.authenticated, true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { username: "admin", password: "test-password" });
  const anonymous = createResetApi("http://backend.test", async () => { throw new Error("should not request"); });
  await assert.rejects(resetKuaishouTasks(parseResetArgs([]), { api: anonymous, now }), /请先登录/);
});

test("invalid credentials stop before any task access and do not expose the password in errors", async () => {
  const fetcher = async url => {
    assert.ok(url.endsWith("/user/login"));
    return { ok: true, json: async () => ({ code: 401, msg: "wrong password" }) };
  };
  await assert.rejects(loginResetAdmin("http://backend.test", { username: "admin", password: "test-secret" }, fetcher), error => {
    assert.match(error.message, /登录失败/); assert.equal(error.message.includes("test-secret"), false); return true;
  });
});

test("the standalone CLI logs in through a PowerShell-style password pipe without saving secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kuaishou-reset-cli-"));
  const log = path.join(directory, "operation.json");
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}");
    requests.push({ url: request.url, body, token: request.headers.satoken });
    response.setHeader("content-type", "application/json");
    const data = request.url === "/user/login"
      ? { tokenName: "satoken", tokenValue: "temporary-test-session" }
      : { total: body.status === "UPLOADING" ? 1 : 0, data: body.status === "UPLOADING" ? [task({ id: 1498 })] : [] };
    response.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/kuaishou-drama-reset-uploading.mjs", import.meta.url)),
      "--base-url", `http://127.0.0.1:${server.address().port}`, "--skip-ids", "1498", "--password-stdin", "--log", log]);
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.stdin.end("\uFEFFtest-password\r\n");
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(exit, 0, output);
    assert.deepEqual(requests[0].body, { username: "admin", password: "test-password" });
    assert.ok(requests.slice(1).every(request => request.token === "temporary-test-session" && request.url.endsWith("/page")));
    const journal = await readFile(log, "utf8");
    assert.equal(JSON.parse(journal).tasks[0].reason, "在跳过列表中");
    for (const secret of ["test-password", "temporary-test-session"]) {
      assert.equal(journal.includes(secret), false); assert.equal(output.includes(secret), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(log, { force: true }); await rmdir(directory);
  }
});

 test("staleness uses last update, supports fractional hours and rejects missing or future timestamps", () => {
  const options = parseResetArgs(["--older-than-hours", "1.5"]);
  assert.ok(resetEligibility(task({ updateTime: "2026-10-31T11:00:00" }), options, now));
  assert.equal(resetEligibility(task({ updateTime: "2026-10-31T10:30:00" }), options, now), null);
  for (const updateTime of [null, "invalid", "2026-11-01T01:00:00"]) assert.ok(resetEligibility(task({ updateTime }), options, now));
});
