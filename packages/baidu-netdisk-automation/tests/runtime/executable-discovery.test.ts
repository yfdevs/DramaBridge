import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultBaiduInstallRoots,
  findBaiduNetdiskExecutable,
} from "../../src/runtime/executable-discovery.js";

test("automatic search includes D drive and user AppData installation roots", () => {
  const roots = defaultBaiduInstallRoots({
    appData: "C:\\Users\\operator\\AppData\\Roaming",
    homeDir: "C:\\Users\\operator",
  });
  assert.ok(roots.includes("D:\\BaiduNetdisk"));
  assert.ok(roots.includes("D:\\Program Files\\BaiduNetdisk"));
  assert.ok(roots.includes("C:\\Users\\operator\\AppData\\Roaming\\baidu\\BaiduNetdisk"));
  assert.equal(new Set(roots).size, roots.length);
});

test("Mac discovery resolves application packages, Applications directories and executable paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-mac-install-"));
  try {
    const bundle = path.join(root, "BaiduNetdisk.app");
    const executable = path.join(bundle, "Contents", "MacOS", "BaiduNetdisk");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "Mac fixture");
    assert.equal(await findBaiduNetdiskExecutable(bundle), executable);
    assert.equal(await findBaiduNetdiskExecutable(root), executable);
    assert.equal(await findBaiduNetdiskExecutable(executable), executable);
    assert.deepEqual(defaultBaiduInstallRoots({ platform: "darwin", homeDir: "/Users/test" }), [
      "/Applications/BaiduNetdisk.app", "/Users/test/Applications/BaiduNetdisk.app",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installation root resolves nested engine, supports quoted paths and legacy executable selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-install-"));
  try {
    const directory = path.join(root, "百度网盘", "BaiduNetdisk");
    const engineDirectory = path.join(directory, "module", "BrowserEngine");
    await mkdir(engineDirectory, { recursive: true });
    const engine = path.join(engineDirectory, "BaiduNetdiskUnite.exe");
    const main = path.join(directory, "BaiduNetdisk.exe");
    await writeFile(engine, "fixture");
    await writeFile(main, "fixture");
    assert.equal(await findBaiduNetdiskExecutable(directory), engine);
    assert.equal(await findBaiduNetdiskExecutable(` "${directory}" `), engine);
    assert.equal(await findBaiduNetdiskExecutable(engineDirectory), engine);
    assert.equal(await findBaiduNetdiskExecutable(main), main);
    await rm(engine);
    // A folder called .exe must not be treated as a launchable file.
    await mkdir(engine);
    assert.equal(await findBaiduNetdiskExecutable(directory), main);
    await assert.rejects(findBaiduNetdiskExecutable(root), /选择 BaiduNetdisk 安装文件夹/);
    await assert.rejects(findBaiduNetdiskExecutable(path.join(root, "missing")), /不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
