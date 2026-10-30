import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBaiduMd5 } from "../../src/domain/file-checksum.js";

test("normalizes the real client obfuscated checksum that caused false upload verification failures", () => {
  assert.equal(normalizeBaiduMd5("950d03eeftcc98a9629d70f25eb58aa6"), "74675546942e4689d71e474963be3595");
  assert.equal(normalizeBaiduMd5("74675546942E4689D71E474963BE3595"), "74675546942e4689d71e474963be3595");
  assert.equal(normalizeBaiduMd5("unknown"), undefined);
  assert.equal(normalizeBaiduMd5("g".repeat(32)), undefined);
  assert.equal(normalizeBaiduMd5(undefined), undefined);
});
