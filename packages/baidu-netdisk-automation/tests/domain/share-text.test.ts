import assert from "node:assert/strict";
import test from "node:test";
import { parseBaiduNetdiskShareText, sanitizeWindowsName } from "../../src/domain/share-text.js";

test("Baidu download names preserve the title used by platform resource readers", () => {
  const title = "我卖老宅供她开店，她让我睡美容床";
  assert.equal(sanitizeWindowsName(title), title);
  const share = parseBaiduNetdiskShareText(
    `通过网盘分享的文件：${title}\nhttps://pan.baidu.com/s/example?pwd=1234`,
  );
  assert.equal(share.name, title);
});

test("HTML-escaped query separators are normalized before opening the share", () => {
  const result=parseBaiduNetdiskShareText('https://pan.baidu.com/s/1example?from=test&amp;pwd=k8qv');
  assert.equal(result.pwd,'k8qv');assert.equal(result.link,'https://pan.baidu.com/s/1example?from=test&pwd=k8qv');
});
