import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { accountSyncUrl, parseSyncAccounts, parseSyncAccountTag, resolveSyncAccountTargets, syncHistoryLabels, syncKuaishouAccounts } from "../../src/automation/account-sync.js";

test("account sync preserves query filters and accepts delimited UID targets", () => {
  const url = new URL(accountSyncUrl(" 剧名 & A "));
  assert.equal(url.searchParams.get("miniSeriesTitle"), "剧名 & A");
  assert.equal(url.searchParams.get("auditStatus"), "3");
  assert.equal(url.searchParams.get("sellingStatus"), "0");
  assert.deepEqual(parseSyncAccounts("123，456\n123"), ["123", "456"]);
  assert.throws(() => parseSyncAccounts(""));
});

test("history names resolve full-width punctuation, hidden accounts and repeated aliases by UID", () => {
  assert.deepEqual(parseSyncAccountTag(" 漫剧大全精选（UID：1644910506） "), { name: "漫剧大全精选", uid: "1644910506" });
  assert.deepEqual(resolveSyncAccountTargets(["漫剧大全精选", "1644910506"], ["漫剧大全精选(UID: 1644910506)"]), ["1644910506"]);
  assert.throws(() => resolveSyncAccountTargets(["重名"], ["重名(UID: 1)", "重名(UID: 2)"]), /重名/);
  assert.throws(() => resolveSyncAccountTargets(["不存在"], []), /未找到账号/);
  assert.deepEqual(syncHistoryLabels({result:1,successful:true,data:[{accountName:"漫剧大全精选",uid:1644910506}]}), ["漫剧大全精选(UID: 1644910506)"]);
  assert.throws(() => syncHistoryLabels({result:0,data:[]}), /读取完整历史/);
});

test("iframe sync selects exact title, retains monetization, waits ten seconds and captures transient errors", async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL("../../../../.cache/playwright-browsers", import.meta.url));
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    await Promise.all(["accepted", "already", "error", "warning", "hidden"].map(async notice => {
      const warning = notice === "error" || notice === "warning";
      const page = await browser.newPage();
      const body = `<table><tbody class="ant-table-tbody"><tr><td>剧名续集</td><td><input type="checkbox"></td></tr><tr><td><span>剧名</span></td><td><input type="checkbox" id="chosen"></td></tr></tbody></table>
        <button onclick="document.querySelector('.ant-modal-content').style.display='block'">批量同步至其他账号</button>
        <div class="ant-modal-content" style="display:none">批量同步至其他账号
        <input placeholder="请批量粘贴或输入账号UID（以英文逗号分隔），回车生效" onkeydown="if(event.key==='Enter'){window.picked=true;this.value.split(',').forEach(uid=>{const tag=document.createElement('span');tag.className='ant-tag';tag.textContent=(uid==='1644910506'?'漫剧大全精选':'测试账号')+'(UID: '+uid+')';selectedAccounts.append(tag)})}">
        <div class="content___test" id="selectedAccounts"></div>
        <span class="historyUidTag_test ant-tag" onclick="window.picked=true;selectedAccounts.innerHTML='<span class=ant-tag>测试账号(UID: 123)</span>'">测试账号(UID: 123)</span>
        <span class="ant-tag">+1</span><button onclick="window.selectedAll=true">一键添加</button>
        <div class="ant-select-selector" onclick="document.querySelector('#option').style.display='block'">请选择</div>
        <span id="option" style="display:none" onclick="window.kept=true">保留原变现方式</span>
        <div class="ant-modal-footer"><button class="ant-btn-primary" onclick="window.confirmed=Date.now(); ${["already", "accepted"].includes(notice) ? "" : "document.querySelector('.ant-modal-content').style.display='none';"} setTimeout(()=>{const n=document.createElement('div');n.className='${notice === "already" ? "ant-message-info" : "ant-message-warning"}';n.innerHTML='<span>${notice === "already" ? "所有任务已同步过" : "批量同步开始，请耐心等待同步完成"}</span>';document.body.append(n);setTimeout(()=>n.remove(),100)},50); ${warning ? `setTimeout(()=>{const n=document.createElement('div');n.className='${notice === "warning" ? "ant-message-warning" : "ant-message-error"}';n.textContent='账号无权限';document.body.append(n);setTimeout(()=>n.remove(),100)},100)` : ""}">确认同步</button></div></div>`;
      await page.route("https://kdj.kuaishou.com/**", route => route.request().url().endsWith('/historySyncAccount')
        ? route.fulfill({json:{result:1,successful:true,data:[{accountName:'测试账号',uid:123},{accountName:'漫剧大全精选',uid:1644910506}]}})
        : route.fulfill({ contentType: "text/html; charset=utf-8", body: route.request().url().includes("/v2/") ? body : '<iframe id="iframe-wrapper" src="/v2/home/content/content-management"></iframe>' }));
      let before = 0;
      const task = syncKuaishouAccounts(page, "剧名", [notice === "hidden" ? "漫剧大全精选" : "测试账号"], () => { before++; });
      if (warning) await assert.rejects(task, /账号无权限/); else await task;
      const frame = page.frames()[1]!;
      const result = await frame.evaluate(() => ({ picked: (window as any).picked, kept: (window as any).kept, checked: (document.querySelector('#chosen') as HTMLInputElement).checked, other: (document.querySelector('input') as HTMLInputElement).checked, elapsed: Date.now() - (window as any).confirmed }));
      assert.equal(before, 1); assert.equal(result.picked, true); assert.equal(result.kept, true);
      assert.equal(result.checked, true); assert.equal(result.other, false); assert.ok(result.elapsed >= 10_000);
      assert.ok(result.elapsed < 20_000);
      assert.equal(await frame.evaluate(() => Boolean((window as any).selectedAll)), false);
      if (notice === "hidden") assert.deepEqual(await frame.locator('[class*="content___"] .ant-tag').allTextContents(), ["漫剧大全精选(UID: 1644910506)"]);
      await page.close();
    }));
  } finally { await browser.close(); }
});
