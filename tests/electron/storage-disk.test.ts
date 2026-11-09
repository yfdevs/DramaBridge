import assert from "node:assert/strict";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readStorageDiskStatus } from "../../electron/core/storage-disk";

test("reads the filesystem for a material directory before it is created", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dramabridge-disk-"));
  try {
    const directory = path.join(root, "missing", "materials");
    const disk = await readStorageDiskStatus(directory);
    const expected = await statfs(root);
    assert.ok(disk);
    assert.equal(disk.directory, directory);
    assert.equal(disk.totalBytes, expected.blocks * expected.bsize);
    assert.ok(disk.availableBytes >= 0);
    assert.ok(disk.usedPercent >= 0 && disk.usedPercent <= 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
