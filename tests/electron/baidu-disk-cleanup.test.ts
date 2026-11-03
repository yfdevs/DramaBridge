import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { canCleanupPlayletDirectory } from "../../electron/platforms/baidu-netdisk/disk-cleanup-policy";
const root = path.resolve("cleanup-test-root");
const localPath = path.join(root, "show");
const downloadDir = path.join(root, "show__hash");
const record = { localPath, downloadDir, state: "completed" };

test("cleanup only accepts known completed historical source directories", () => {
  assert.equal(canCleanupPlayletDirectory(localPath, [record], []), true);
  assert.equal(canCleanupPlayletDirectory(path.join(root, "unknown"), [record], []), false);
  for (const state of ["downloading", "pending", "failed"]) {
    assert.equal(canCleanupPlayletDirectory(localPath, [record, { ...record, state }], []), false);
  }
});
test("native download roots remain protected even with stale mtimes or completed records", () => {
  assert.equal(canCleanupPlayletDirectory(downloadDir, [record], []), false);
  assert.equal(canCleanupPlayletDirectory(root, [record], []), false);
});
test("session material protection survives download completion and is checked dynamically", () => {
  const protectedPaths = new Set<string>();
  assert.equal(canCleanupPlayletDirectory(localPath, [record], protectedPaths), true);
  protectedPaths.add(path.join(localPath, "nested"));
  assert.equal(canCleanupPlayletDirectory(localPath, [record], protectedPaths), false);
  assert.equal(canCleanupPlayletDirectory(localPath, [record], [root]), false);
  assert.equal(canCleanupPlayletDirectory(localPath, [record], [path.join(root, "show-other")]), true);
});
