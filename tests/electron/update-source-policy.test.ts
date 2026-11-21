import assert from "node:assert/strict";
import test from "node:test";
import { preferredUpdateSource } from "../../electron/core/update-source-policy";

const result = (id: string) => ({source:{id}});
test("v4 is preferred regardless of discovery order", () => {
  const v4=result('gh-proxy-v4');
  assert.equal(preferredUpdateSource([result('github'),result('gh-proxy-v6'),v4]),v4);
});
test("excluded or failed sources fall back from v4 to v6 and then official GitHub", () => {
  const v6=result('gh-proxy-v6'), github=result('github');
  assert.equal(preferredUpdateSource([github,v6]),v6);
  assert.equal(preferredUpdateSource([github]),github);
  assert.equal(preferredUpdateSource([]),undefined);
});
