import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePinduoduoResourceTitle,
  PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE,
  resolvePinduoduoResource,
  type PinduoduoLegacyResourceLink,
} from "../../src/storage/pinduoduo-legacy-resource-links.js";
import { PINDUODUO_LEGACY_RESOURCE_LINKS } from "../../src/shared/pinduoduo-legacy-resource-links.generated.js";

function legacyLink(
  overrides: Partial<PinduoduoLegacyResourceLink> = {},
): PinduoduoLegacyResourceLink {
  return {
    normalizedTitle: "果园的天平",
    title: "果园的天平",
    originalShareText: "https://pan.baidu.com/s/example 提取码: 1234",
    baiduUrl: "https://pan.baidu.com/s/example",
    sourceDate: "2026-09-22",
    episodeCount: 43,
    sourceRows: [1200],
    available: true,
    ...overrides,
  };
}

test("normalizes harmless title formatting without fuzzy matching", () => {
  assert.equal(normalizePinduoduoResourceTitle("  果 园的天平？！  "), "果园的天平");
  assert.notEqual(normalizePinduoduoResourceTitle("果园天平"), "果园的天平");
});

test("uses the historical spreadsheet original link when the title matches", () => {
  const resolved = resolvePinduoduoResource(
    "果园的天平",
    "https://pan.baidu.com/s/sample",
    PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE - 1,
    legacyLink(),
  );

  assert.equal(resolved.source, "LEGACY_XLSX_ORIGINAL");
  assert.equal(resolved.shareText, "https://pan.baidu.com/s/example 提取码: 1234");
  assert.deepEqual(resolved.sourceRows, [1200]);
});

test("fails closed when a matched historical row has no original link", () => {
  assert.throws(
    () => resolvePinduoduoResource(
      "缺少原链接的旧剧",
      "https://pan.baidu.com/s/sample",
      PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE - 1,
      legacyLink({ originalShareText: null, baiduUrl: null, available: false }),
    ),
    /PINDUODUO_LEGACY_RESOURCE_LINK_MISSING/,
  );
});

test("uses the Pinduoduo list link from the cutoff onward even when a legacy title matches", () => {
  const resolved = resolvePinduoduoResource(
    "果园的天平",
    "https://pan.baidu.com/s/full-version",
    PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE,
    legacyLink(),
  );

  assert.deepEqual(resolved, {
    shareText: "https://pan.baidu.com/s/full-version",
    source: "PINDUODUO_LIST",
  });
});

test("requires an old record to match the historical resource table", () => {
  assert.throws(
    () => resolvePinduoduoResource(
      "历史表未收录的旧剧",
      "https://pan.baidu.com/s/platform-link",
      PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE - 1,
      undefined,
    ),
    /PINDUODUO_LEGACY_RESOURCE_NOT_FOUND/,
  );
});

test("requires gmt_create before choosing a resource source", () => {
  assert.throws(
    () => resolvePinduoduoResource(
      "缺少创建时间的剧",
      "https://pan.baidu.com/s/platform-link",
      undefined,
      undefined,
    ),
    /PINDUODUO_GMT_CREATE_MISSING/,
  );
});

test("generated seed contains the known historical full link and preserves missing-link rows", () => {
  const known = PINDUODUO_LEGACY_RESOURCE_LINKS.find(
    (entry) => entry.normalizedTitle === "果园的天平",
  );

  assert.equal(PINDUODUO_LEGACY_RESOURCE_LINKS.length, 1285);
  assert.equal(PINDUODUO_LEGACY_RESOURCE_LINKS.filter((entry) => entry.available).length, 1279);
  assert.match(known?.originalShareText ?? "", /pan\.baidu\.com\/s\/1_Uie5taISqN-W6bHr3Z-gQ/);
});
