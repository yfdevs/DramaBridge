import assert from "node:assert/strict";
import test from "node:test";

import {
  isBaiduCoverSlotNotReadyError,
  isBaiduDropdownOptionNotFoundError,
  isBaiduInformationConfirmNotClosedError,
  isBaiduDailyPublishLimitError,
  nextBaiduTaskClaimResumeAt,
} from "../../src/app/runtime.js";

test("pauses Baidu task claims when the daily publish allowance is zero", () => {
  assert.equal(
    isBaiduDailyPublishLimitError(
      new Error(
        "BAIDU_DRAMA_FORM_ERROR: 提交短剧审核: 今日还可发布0篇内容，您当前提交的内容篇数过多",
      ),
    ),
    true,
  );
  assert.equal(
    isBaiduDailyPublishLimitError(
      new Error("BAIDU_DRAMA_FORM_ERROR: 提交短剧审核: 剧情分类不能为空"),
    ),
    false,
  );
});

test("resumes Baidu task claims at 1 AM on the next local day", () => {
  const now = new Date(2026, 9, 14, 0, 30, 0);
  assert.equal(nextBaiduTaskClaimResumeAt(now), new Date(2026, 9, 15, 1, 0, 0).getTime());
});

test("retries only when the Baidu information confirmation dialog stays open", () => {
  assert.equal(
    isBaiduInformationConfirmNotClosedError(
      new Error("BAIDU_DRAMA_INFORMATION_CONFIRM_NOT_CLOSED"),
    ),
    true,
  );
  assert.equal(
    isBaiduInformationConfirmNotClosedError(
      new Error("BAIDU_DRAMA_TYPE_CHANGE_CONFIRM_NOT_CLOSED"),
    ),
    false,
  );
});

test("retries the whole Baidu form when a dropdown option did not load", () => {
  assert.equal(
    isBaiduDropdownOptionNotFoundError(
      new Error("BAIDU_DRAMA_DROPDOWN_OPTION_NOT_FOUND: 男频"),
    ),
    true,
  );
  assert.equal(
    isBaiduDropdownOptionNotFoundError(
      new Error("BAIDU_DRAMA_FORM_ERROR: 剧情分类不能为空"),
    ),
    false,
  );
});

test("retries the whole Baidu form only when a cover slot was not retained", () => {
  assert.equal(
    isBaiduCoverSlotNotReadyError(
      new Error("BAIDU_DRAMA_COVER_SLOT_NOT_READY: slot=3:4"),
    ),
    true,
  );
  assert.equal(
    isBaiduCoverSlotNotReadyError(
      new Error("BAIDU_DRAMA_COVER_SLOT_LOST: slot=16:9"),
    ),
    true,
  );
  assert.equal(
    isBaiduCoverSlotNotReadyError(
      new Error("BAIDU_DRAMA_COVER_UPLOAD_REJECTED: 图片尺寸不符"),
    ),
    false,
  );
});
