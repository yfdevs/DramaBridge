import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRecreationTitle, validateRecreationTitle } from "../../electron/integrations/feishu/task-validation";

test("normalizes multiline spreadsheet titles and explicit platform notes", () => {
  const title = normalizeRecreationTitle("来自亲情的账单\r\n（抖音上架剧名）");
  assert.equal(title, "来自亲情的账单");
  assert.doesNotThrow(() => validateRecreationTitle(title));
  assert.equal(normalizeRecreationTitle("  来自亲情的账单\n "), title);
  assert.equal(normalizeRecreationTitle("剧名（下）"), "剧名（下）");
  assert.equal(normalizeRecreationTitle("剧名\n续篇"), "剧名 续篇");
});
test("normalization retains filename validation", () => {
  for (const value of ["../剧名", "剧名:续篇", "（抖音上架剧名）", "CON", "剧名\u0000"]) {
    assert.throws(() => validateRecreationTitle(normalizeRecreationTitle(value)));
  }
});
