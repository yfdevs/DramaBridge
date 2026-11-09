import assert from "node:assert/strict";
import test from "node:test";
import { packagingTarget } from "../../scripts/packaging-target.mjs";

test("Mac native dependencies default to the Apple Silicon host architecture", () => {
  assert.deepEqual(packagingTarget([], "darwin", "arm64"), { platform: "darwin", arch: "arm64" });
  assert.deepEqual(packagingTarget(["--mac", "--arm64", "--dir"], "darwin", "arm64"), { platform: "darwin", arch: "arm64" });
});

test("Mac packaging rejects Intel, Rosetta, universal and foreign host builds before staging", () => {
  for (const [args, platform, arch] of [
    [["--mac"], "darwin", "x64"],
    [["--mac", "--x64"], "darwin", "arm64"],
    [["--mac", "--universal"], "darwin", "arm64"],
    [["--mac", "--arm64"], "win32", "x64"],
    [["--mac", "--arm64"], "linux", "arm64"],
  ]) assert.throws(() => packagingTarget(args, platform, arch), /Apple Silicon/);
});

test("Windows x64 packaging retains its native dependency architecture", () => {
  assert.deepEqual(packagingTarget(["--win", "--x64", "--publish", "never"], "win32", "x64"), { platform: "win32", arch: "x64" });
});

test("a single native staging directory cannot mix platforms or architectures", () => {
  assert.throws(() => packagingTarget(["--mac", "--win"], "darwin", "arm64"), /one platform/);
  assert.throws(() => packagingTarget(["--arm64", "--x64"], "darwin", "arm64"), /one architecture/);
});
