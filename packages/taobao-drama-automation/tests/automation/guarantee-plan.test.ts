import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import { fillTaobaoGuaranteePlan } from "../../src/automation/guarantee-plan.js";
import type { TaobaoCollectionMetadata } from "../../src/shared/types.js";

for (const plan of ["暂不参与", "新剧保底", "热剧保底"] as const) {
  test(`fills guarantee plan ${plan} and only uploads when participating`, async () => {
    let downloads = 0;
    const server = createServer((_request, response) => {
      downloads++;
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    const browser = await chromium.launch({ channel: "chromium", headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div id="guaranteePlanType">${["新剧保底", "热剧保底", "暂不参与"].map(value => `<label><input type="radio" name="plan" value="${value}">${value}</label>`).join("")}</div>
        <div id="details" hidden>
          <div id="offsiteRankPlatform"><label><input name="platform" type="radio">dataeye</label><label><input name="platform" type="radio">其它</label></div>
          <div class="next-form-item"><label for="offsiteRankScreenshotUrls">站外平台上榜截图</label><input type="file"><span id="count">0/9</span></div>
        </div>
        <script>
          document.querySelector('#guaranteePlanType').onchange = event => { document.querySelector('#details').hidden = event.target.value === '暂不参与'; };
          document.querySelector('input[type=file]').onchange = () => { setTimeout(() => { document.querySelector('#count').textContent = '1/9'; }, 100); };
        </script>`);
      const data = { guaranteePlanType: plan, offsiteRankPlatform: plan === "热剧保底" ? "其它" : "dataeye",
        offsiteRankScreenshotUrls: [`http://127.0.0.1:${address.port}/rank.png`],
      } as TaobaoCollectionMetadata;
      await fillTaobaoGuaranteePlan(page, data);
      assert.equal(await page.locator('#guaranteePlanType input:checked').inputValue(), plan);
      assert.equal(downloads, plan === "暂不参与" ? 0 : 1);
      if (plan !== "暂不参与") assert.equal(await page.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files?.length), 1);
    } finally { await browser.close(); server.close(); }
  });
}
