import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { assertPinduoduoLoginPhone, resolvePinduoduoCreator, selectPinduoduoCreator } from "../../src/app/creator-account.js";

const creator = { anchor_uid: 7735796497358, anchor_name: "草莓漫剧", room_id: "1053168546", upload_video: true, permit_operate: true };
test("checks the masked login phone against the Feishu account before resolving an author", () => {
  assert.doesNotThrow(() => assertPinduoduoLoginPhone("177****4154", "17732354154"));
  assert.throws(() => assertPinduoduoLoginPhone("180****1189", "17732354154"), /不一致/);
  assert.throws(() => assertPinduoduoLoginPhone("unknown", "17732354154"), /不一致/);
});
test("uses the internal anchor UID, not the visible room ID", () => {
  assert.equal(selectPinduoduoCreator([creator], "草莓漫剧").anchor_uid, 7735796497358);
});
test("requires exact creator matching and rejects ambiguous or unauthorized authors", () => {
  assert.throws(() => selectPinduoduoCreator([creator], "草莓"), /未.*找到/);
  assert.throws(() => selectPinduoduoCreator([creator, { ...creator, anchor_uid: 2 }], "草莓漫剧"), /同名/);
  assert.throws(() => selectPinduoduoCreator([creator, { ...creator, anchor_uid: 2, anchor_name: "其他" }]), /多个主播/);
  assert.throws(() => selectPinduoduoCreator([{ ...creator, upload_video: false }]), /上传权限/);
});

test("captures the website's signed list requests, paginates, and closes its lookup tab", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const context = await browser.newContext();
    const requests: number[] = [];
    await context.route("https://mcn.pinduoduo.com/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/home/management") {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button title="下一页" onclick="load(2)">下一页</button><script>
          fetch('/api/cafe/login/user_info',{method:'POST',body:'{}'});
          function load(page) { return fetch('/api/cafe/anchor/list_signed_anchors', {method:'POST',headers:{'content-type':'application/json','x-site-request':'yes'},body:JSON.stringify({page,page_size:1})}); }
          load(1);
        </script>` }); return;
      }
      if (path === "/api/cafe/login/user_info") {
        await route.fulfill({ json: { success: true, result: { user_name: "177****4154" } } }); return;
      }
      if (path === "/api/cafe/anchor/list_signed_anchors") {
        assert.equal(route.request().headers()["x-site-request"], "yes");
        const page = route.request().postDataJSON().page as number; requests.push(page);
        await route.fulfill({ json: { success: true, result: { model: [page === 1 ? { ...creator, anchor_name: "其他", anchor_uid: 2 } : creator], page, page_size: 1, total: 2 } } }); return;
      }
      await route.abort();
    });
    const result = await resolvePinduoduoCreator(context, { accountPhone: "17732354154", config: { creatorName: "草莓漫剧", creatorUid: "111" } });
    assert.equal(String(result.anchor_uid), "7735796497358");
    assert.deepEqual(requests, [1, 2]);
    assert.equal(context.pages().length, 0);
  } finally { await browser.close(); }
});
