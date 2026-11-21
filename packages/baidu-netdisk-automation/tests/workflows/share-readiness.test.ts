import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  isBaiduShareListReady,
  baiduShareCodeExpression,
  baiduShareReadyStateExpression,
  selectTrackedBaiduShareTarget,
  waitForShareReadyTarget,
  type ShareReadyRuntime,
  type ShareReadyState,
  configureBaiduNetdiskAutomationLogging,
} from "../../src/workflows/download-baidu-folder.js";
import type { CdpTarget } from "../../src/domain/types.js";

configureBaiduNetdiskAutomationLogging({ console: false });

const share = { link: "https://pan.baidu.com/s/1example?pwd=2n63", pwd: "2n63", name: "分享页测试" };
const target = (id = "share-1", url = share.link): CdpTarget => ({ id, type: "page", title: "分享文件", url, webSocketDebuggerUrl: `ws://localhost/${id}` });
const state = (values: Partial<ShareReadyState> = {}): ShareReadyState => ({
  url: share.link, title: "分享文件", text: "全部文件", readyState: "complete", htmlLength: 1000,
  documentId: 'initial-document',
  needsCode: false, captcha: false, readyForList: true, failureText: "", hasShareMetadata: true,
  ...values,
});

function setup() {
  let now = 0;
  const fixture = {
    current: target() as CdpTarget | undefined,
    page: state(), extracts: 0, reopens: 0, reloads: 0,
    time: () => now,
  };
  const runtime: ShareReadyRuntime = {
    now: () => now, sleep: async milliseconds => { now += milliseconds; },
    find: async () => fixture.current,
    read: async () => fixture.page,
    extract: async () => { fixture.extracts++; fixture.page = state(); },
    reopen: async () => { fixture.reopens++; fixture.current = target(`reopened-${fixture.reopens}`); fixture.page = state(); return fixture.current; },
    reload: async () => { fixture.reloads++; fixture.page = state(); },
    targets: async () => fixture.current ? [fixture.current] : [],
  };
  return { fixture, runtime, wait: () => waitForShareReadyTarget(9337, share, [], 90_000, runtime) };
}

test("a late extraction form is submitted even though the initial page had no input", async () => {
  const { fixture, runtime, wait } = setup();
  let reads = 0;
  runtime.read = async () => {
    if (fixture.extracts) return state();
    return state({ text: ++reads < 3 ? "正在加载" : "提取中...", needsCode: reads >= 3, hasShareMetadata: false, readyForList: false });
  };
  await wait();
  assert.equal(fixture.extracts, 1);
  assert.equal(fixture.reopens, 0);
});

test("target replacement and a destroyed extraction context do not count as success", async () => {
  const { fixture, runtime, wait } = setup();
  fixture.page = state({ needsCode: true, hasShareMetadata: false });
  let reads = 0;
  runtime.read = async () => { reads++; return fixture.page; };
  runtime.extract = async () => {
    fixture.extracts++;
    fixture.current = target("replacement");
    fixture.page = state();
    throw new Error("Execution context was destroyed");
  };
  assert.equal((await wait()).id, "replacement");
  assert.ok(reads >= 2);
});

test("an extraction that stays pending is retried with a delay", async () => {
  const { fixture, runtime, wait } = setup();
  fixture.page = state({ needsCode: true, hasShareMetadata: false });
  const times: number[] = [];
  runtime.extract = async () => {
    fixture.extracts++; times.push(fixture.time());
    if (fixture.extracts === 2) fixture.page = state();
  };
  await wait();
  assert.equal(fixture.extracts, 2);
  assert.ok(times[1]! - times[0]! >= 5000);
});

test("the user's own disk is not mistaken for a share list", async () => {
  const { fixture, wait } = setup();
  fixture.page = state({ url: "https://pan.baidu.com/disk/main#/index", hasShareMetadata: false });
  const result = await wait();
  assert.equal(fixture.reopens, 1);
  assert.ok(result.url.includes("/s/1example"));
});

test("a complete but blank HTML shell is refreshed once", async () => {
  const { fixture, wait } = setup();
  fixture.page = state({ text: "", htmlLength: 1000, hasShareMetadata: false });
  await wait();
  assert.equal(fixture.reloads, 1);
  assert.equal(fixture.reopens, 0);
  assert.ok(fixture.time() >= 8000);
});

test("a missing target and a browser network error reopen a dedicated share page", async () => {
  for (const absent of [true, false]) {
    const { fixture, wait } = setup();
    if (absent) fixture.current = undefined;
    else fixture.page = state({ url: "chrome-error://chromewebdata/", hasShareMetadata: false });
    await wait();
    assert.equal(fixture.reopens, 1);
  }
});

test("confirmed invalid shares fail after one fresh open; captchas never trigger automated retries", async () => {
  for (const values of [{ failureText: "分享已取消" }, { captcha: true }]) {
    const { fixture, runtime, wait } = setup();
    fixture.page = state(values);
    runtime.reopen = async () => { fixture.reopens++; fixture.current = target('fresh'); fixture.page = state({...values, documentId:'fresh-document'}); return fixture.current; };
    await assert.rejects(wait(), /分享链接不可用|验证码/);
    assert.equal(fixture.reopens, values.failureText ? 1 : 0);
    assert.equal(fixture.extracts + fixture.reloads, 0);
  }
});

test("another share's deleted-file message cannot invalidate the requested share", async () => {
  const {fixture, wait} = setup();
  fixture.page = state({url:'https://pan.baidu.com/s/1other',failureText:'分享的文件已经被删除'});
  assert.ok((await wait()).url.includes('1example'));
  assert.equal(fixture.reopens,1);
});

test("loading and transient deleted-file messages are not terminal", async () => {
  const {fixture,runtime,wait} = setup();let reads=0;
  runtime.read=async()=>++reads<3?state({readyState:'loading',failureText:'分享的文件已经被删除'}):state();
  await wait();assert.equal(fixture.reopens,0);
});

test("a fresh open can recover from a stale completed deleted-file page", async () => {
  const {fixture,wait}=setup();fixture.page=state({failureText:'分享的文件已经被删除'});
  await wait();assert.equal(fixture.reopens,1);assert.equal(fixture.extracts,0);
});

test("a reused window gets time to commit navigation before spending reopen attempts", async () => {
  const {fixture,runtime,wait}=setup();
  runtime.read=async()=>fixture.time()<2000
    ? state({url:'https://pan.baidu.com/s/1previous',failureText:'分享文件已过期'}) : state();
  await wait();
  assert.equal(fixture.reopens,0);
});

test("reopening the same stale document cannot confirm expiration", async () => {
  const {fixture,runtime,wait}=setup();
  fixture.page=state({failureText:'分享文件已过期'});
  runtime.reopen=async()=>{fixture.reopens++;return fixture.current!;};
  await assert.rejects(wait(),error => error instanceof Error
    && /尚未确认链接失效/.test(error.message) && !/分享链接不可用/.test(error.message));
  assert.equal(fixture.reopens,1);
});

test("a real file list wins over incidental expired text", async () => {
  const {fixture,wait}=setup();
  fixture.page=state({hasFileList:true,failureText:'分享文件已过期',text:'全部文件 分享文件已过期.mp4'});
  await wait();
  assert.equal(fixture.reopens,0);
});

test("verification endpoint errors are pending observations rather than permanent invalidation", async () => {
  const result=await runInNewContext(baiduShareCodeExpression(share), {
    URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
    document:{body:{innerText:'请输入提取码'}},
    location:{href:'https://pan.baidu.com/share/init?surl=example'},
    fetch:async()=>({json:async()=>({errno:-1,errmsg:'分享文件已过期'})}),
  });
  assert.equal(result.pending,true);
  assert.match(result.detail,/提取接口尚未确认/);
});

test("an unreadable confirmed extraction route still gets a bounded extraction attempt", async () => {
  const {fixture,runtime,wait}=setup();
  fixture.current=target('init','https://pan.baidu.com/share/init?surl=example&amp;pwd=2n63');
  runtime.read=async()=>{if(!fixture.extracts)throw new Error('fixture DOM read timed out');return state();};
  await wait();assert.equal(fixture.extracts,1);assert.equal(fixture.reopens,0);
});

test("unreadable unrelated targets never submit a password and retain the original diagnostic", async () => {
  const {fixture,runtime,wait}=setup();fixture.current=target('unrelated','https://pan.baidu.com/share/init?surl=other');
  runtime.read=async()=>{throw new Error('fixture DOM read failed');};
  runtime.reopen=async()=>{fixture.reopens++;return fixture.current!;};
  await assert.rejects(wait(),/状态读取失败=fixture DOM read failed/);
  assert.equal(fixture.extracts,0);assert.equal(fixture.reopens,2);
});

test("a stuck extraction has bounded retries and useful final diagnostics", async () => {
  const { fixture, runtime, wait } = setup();
  fixture.page = state({ needsCode: true, hasShareMetadata: false });
  runtime.extract = async () => { fixture.extracts++; };
  runtime.reopen = async () => { fixture.reopens++; return fixture.current!; };
  await assert.rejects(wait(), /没有进入分享文件列表。提取尝试=6；重新打开=2/);
  assert.equal(fixture.reopens, 2);
  assert.equal(fixture.extracts, 6);
  assert.ok(fixture.time() <= 90_500);
});

test("target recovery excludes AI pages and other shares and prioritizes the latest tracked page", () => {
  const expected = target("expected");
  const other = target("other", "https://pan.baidu.com/s/1another");
  const ai = target("ai", "https://pan.baidu.com/aipan/search");
  assert.equal(selectTrackedBaiduShareTarget([ai], [expected], "example"), undefined);
  assert.equal(selectTrackedBaiduShareTarget([other], [expected], "example"), undefined);
  const latest = target("latest");
  assert.equal(selectTrackedBaiduShareTarget([expected, latest], [latest, expected], "example"), latest);
  assert.equal(selectTrackedBaiduShareTarget([target("query", "https://pan.baidu.com/share/init?surl=1abc")], [expected], "1abc")?.id, "query");
});

test("tracked targets cannot borrow a matching ID from a title, query or longer link", () => {
  for (const url of ['https://pan.baidu.com/s/1example-extra','https://pan.baidu.com/s/1other?redirect=example','https://example.com/s/1example','https://pan.baidu.com/aipan/search','https://pan.baidu.com/disk/main']) {
    const candidate={...target('same',url),title:'pan.baidu.com example'};
    assert.equal(selectTrackedBaiduShareTarget([candidate],[candidate],'example'),undefined,url);
  }
});

test("the serialized list classifier requires share metadata and a finished extraction", () => {
  const ready = runInNewContext(`(${isBaiduShareListReady.toString()})`, { URL }) as typeof isBaiduShareListReady;
  assert.equal(ready(state()), true);
  assert.equal(ready(state({ needsCode: true })), false);
  assert.equal(ready(state({ hasShareMetadata: false })), false);
  assert.equal(ready(state({ url: "https://pan.baidu.com/disk/main#/index", hasShareMetadata: false })), false);
});

test("the real readiness script recognizes an auto-extracting page whose form is hidden", () => {
  const url = new URL("https://pan.baidu.com/share/init?surl=example&pwd=2n63");
  const result = runInNewContext(baiduShareReadyStateExpression(), {
    URL, location: { href: url.href, pathname: url.pathname },
    document: {
      title: "请输入提取码", readyState: "complete", body: { innerText: "提取中..." },
      documentElement: { outerHTML: "<html>loading</html>" },
      querySelector: () => ({ getClientRects: () => [] }),
    },
  }) as ShareReadyState;
  assert.equal(result.needsCode, true);
  assert.equal(result.readyForList, false);
});

test("the real extraction script persists the verification key and navigates to the requested share", async () => {
  let assigned = "";
  const saved = new Map<string, string>();
  const document = { body: { innerText: "提取中..." }, cookie: "" };
  const result = await runInNewContext(baiduShareCodeExpression(share), {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, document,
    location: { href: "https://pan.baidu.com/share/init?surl=example", assign: (url: string) => { assigned = url; } },
    localStorage: { setItem: (key: string, value: string) => saved.set(key, value) },
    fetch: async (_url: string, options: { body: URLSearchParams }) => {
      assert.equal(options.body.get("pwd"), share.pwd);
      return { json: async () => ({ errno: 0, randsk: "fixture-verification-key" }) };
    },
  });
  assert.equal(result.submitted, true);
  assert.equal(assigned, share.link);
  assert.equal(saved.get("example_bdclnd"), "fixture-verification-key");
  assert.match(document.cookie, /BDCLND=fixture-verification-key/);
});
