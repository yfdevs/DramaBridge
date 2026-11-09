import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRuntimeDirectory } from "../../electron/platforms/shared/directory-path";

test("macOS recovers saved Windows runtime defaults", () => {
  assert.equal(normalizeRuntimeDirectory("D:\\.drama-runs\\qq-drama", "darwin"), ".drama-runs/qq-drama");
  assert.equal(normalizeRuntimeDirectory("D:/.drama-runs/qq-drama", "darwin"), ".drama-runs/qq-drama");
});

test("native directories and Windows selections remain intact", () => {
  for (const value of ["/Users/test/data", ".drama-runs/qq-drama"]) {
    assert.equal(normalizeRuntimeDirectory(value, "darwin"), value);
  }
  assert.equal(normalizeRuntimeDirectory("D:\\.drama-runs\\qq-drama", "win32"), "D:\\.drama-runs\\qq-drama");
});

test("foreign custom directories are rejected instead of joined to the project", () => {
  for (const value of ["D:\\custom", "\\\\server\\profiles"]) {
    assert.throws(() => normalizeRuntimeDirectory(value, "darwin"), /Windows/);
  }
});
