import assert from "node:assert/strict";
import test from "node:test";

import {
  isBaiduCoverSlotNotReadyError,
  isBaiduDropdownOptionNotFoundError,
  isBaiduInformationConfirmNotClosedError,
} from "../../src/app/runtime.js";

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
