import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { electronArtifactChecksum, officialElectronArtifact, prepareMacElectronRuntime } from "../../src/runtime/mac-electron-runtime.js";

test("runtime selection permits only exact official version and architecture artifacts", () => {
  const artifact = officialElectronArtifact("26.2.0", "arm64");
  assert.equal(artifact.archiveUrl, "https://github.com/electron/electron/releases/download/v26.2.0/electron-v26.2.0-darwin-arm64.zip");
  assert.throws(() => officialElectronArtifact("../../other", "arm64"), /UNSUPPORTED/);
  assert.throws(() => officialElectronArtifact("26.2.0", "https://other"), /UNSUPPORTED/);
  const sha = "a".repeat(64);
  assert.equal(electronArtifactChecksum(`${sha} *${artifact.name}\r\n`, artifact.name), sha);
  assert.throws(() => electronArtifactChecksum(`${sha} *other.zip`, artifact.name), /CHECKSUM_MISSING/);
});

test("verified runtime preparation shares downloads, detects cache corruption and preserves old copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-mac-runtime-"));
  try {
    const artifact = officialElectronArtifact("26.2.0", "arm64");
    const bytes = Buffer.from("official runtime archive fixture");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let downloads = 0;
    let extractions = 0;
    const dependencies = {
      download: async (url: string, destination: string) => {
        downloads++;
        assert.ok(url.startsWith("https://github.com/electron/electron/releases/download/v26.2.0/"));
        await writeFile(destination, url.endsWith("SHASUMS256.txt") ? `${checksum} *${artifact.name}\n` : bytes);
      },
      extract: async (_archive: string, directory: string) => {
        extractions++;
        const bin = path.join(directory, "Electron.app", "Contents", "MacOS");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "Electron"), "verified executable");
      },
    };
    const results = await Promise.all([prepareMacElectronRuntime("26.2.0", "arm64", root, dependencies), prepareMacElectronRuntime("26.2.0", "arm64", root, dependencies)]);
    assert.equal(results[0], results[1]);
    assert.equal(downloads, 2);
    assert.equal(extractions, 1);
    assert.equal(await prepareMacElectronRuntime("26.2.0", "arm64", root, dependencies), results[0]);
    assert.equal(downloads, 2);
    await writeFile(results[0]!, "corrupted");
    const repaired = await prepareMacElectronRuntime("26.2.0", "arm64", root, dependencies);
    assert.notEqual(repaired, results[0]);
    assert.equal(await readFile(repaired, "utf8"), "verified executable");
    assert.equal(await readFile(results[0]!, "utf8"), "corrupted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checksum mismatches prevent extraction and leave no launchable incomplete cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-mac-runtime-rejected-"));
  try {
    const name = officialElectronArtifact("26.2.0", "arm64").name;
    let extracted = false;
    await assert.rejects(prepareMacElectronRuntime("26.2.0", "arm64", root, {
      download: async (url, destination) => { await writeFile(destination, url.endsWith("SHASUMS256.txt") ? `${"a".repeat(64)} *${name}\n` : "wrong bytes"); },
      extract: async () => { extracted = true; },
    }), /CHECKSUM_MISMATCH/);
    assert.equal(extracted, false);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a staging cleanup failure never hides the original preparation error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-mac-runtime-cleanup-"));
  const original = new Error("original download failure");
  let cleanupAttempted = false;
  try {
    await assert.rejects(prepareMacElectronRuntime("26.2.0", "arm64", root, {
      download: async () => { throw original; },
      extract: async () => { assert.fail("failed downloads cannot be extracted"); },
      cleanup: async () => {
        cleanupAttempted = true;
        throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
      },
    }), error => error === original);
    assert.equal(cleanupAttempted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
