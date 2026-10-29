import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withReleaseVersion } from "../../scripts/release-version.mjs";

async function manifestFixture(t, version = "0.2.22") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dramabridge-release-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    return rm(directory, { recursive: true, force: true });
  });
  const manifestPath = path.join(directory, "package.json");
  const original = `{\r\n  "name": "dramabridge",\r\n  "version": "${version}",\r\n  "custom": "keep local edits"\r\n}\r\n`;
  await writeFile(manifestPath, original);
  return { manifestPath, original };
}

test("increments only the patch version before releasing and keeps it on success", async (t) => {
  const { manifestPath, original } = await manifestFixture(t);
  await withReleaseVersion(manifestPath, async (version) => {
    assert.equal(version, "0.2.23");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).version, "0.2.23");
  });
  assert.equal(await readFile(manifestPath, "utf8"), original.replace("0.2.22", "0.2.23"));
});

for (const failedStage of ["build", "package", "publish"]) {
  test(`restores the exact original manifest when ${failedStage} fails`, async (t) => {
    const { manifestPath, original } = await manifestFixture(t);
    const failure = new Error(`${failedStage} failed`);
    const completed = [];
    await assert.rejects(withReleaseVersion(manifestPath, async () => {
      for (const stage of ["build", "package", "publish"]) {
        assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).version, "0.2.23");
        if (stage === failedStage) throw failure;
        completed.push(stage);
      }
    }), (error) => error === failure);
    assert.equal(await readFile(manifestPath, "utf8"), original);
    assert.ok(!completed.includes(failedStage));
  });
}

test("rejects an invalid version without changing the manifest or starting a release", async (t) => {
  const { manifestPath, original } = await manifestFixture(t, "invalid");
  await assert.rejects(withReleaseVersion(manifestPath, async () => {
    assert.fail("release must not start");
  }), /Invalid release version/);
  assert.equal(await readFile(manifestPath, "utf8"), original);
});
