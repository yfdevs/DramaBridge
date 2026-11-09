import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createPackage } from "@electron/asar";
import { prepareMacBaiduCdpLauncher } from "../../src/runtime/mac-cdp-launcher.js";
import { baiduLauncherSources, prepareBaiduCdpLauncher } from "../../src/runtime/cdp-launcher.js";

async function fixture(root: string, name = "client", main = "dist/electron/entry.js", version = "8.9.7") {
  const engine = path.join(root, name);
  const app = path.join(root, `${name}-app`);
  await mkdir(path.dirname(path.join(app, main)), { recursive: true });
  await mkdir(path.join(engine, "resources"), { recursive: true });
  await mkdir(path.join(engine, "locales"), { recursive: true });
  await mkdir(path.join(engine, "users"), { recursive: true });
  await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "baidunetdisk", version, main }));
  await writeFile(path.join(app, main), "module.exports = 'original client';");
  await createPackage(app, path.join(engine, "resources", "app.asar"));
  await writeFile(path.join(engine, "resources", "core.asar"), "original core");
  await writeFile(path.join(engine, "locales", "zh-CN.pak"), "locale");
  await writeFile(path.join(engine, "users", "private-profile"), "must not be copied");
  await writeFile(path.join(engine, "BaiduNetdiskUnite.exe"), "original signed executable");
  await writeFile(path.join(engine, "browserengine.dll"), "native runtime v1");
  return { engine, app, executable: path.join(engine, "BaiduNetdiskUnite.exe") };
}

const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

async function removeFixture(root: string) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(root).startsWith('baidu-cdp-'));
  await rm(root, { recursive: true, force: true });
}

test("prepares an unmodified runtime copy, preserves the installation and reuses a verified cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-cdp-cache-"));
  try {
    const source = await fixture(root);
    const original = await readFile(source.executable);
    const originalFiles = await readdir(source.engine);
    const cache = path.join(root, "cache");
    const first = await prepareBaiduCdpLauncher(source.executable, cache);
    assert.ok(first.startsWith(cache + path.sep));
    assert.equal(digest(await readFile(first)), digest(original));
    assert.deepEqual(await readFile(source.executable), original);
    assert.deepEqual(await readdir(source.engine), originalFiles);
    await assert.rejects(readFile(path.join(path.dirname(first), "users", "private-profile")), /ENOENT/);
    assert.equal(await prepareBaiduCdpLauncher(source.executable, cache), first);
    const preload = await readFile(path.join(path.dirname(first), "resources/app/preload.cjs"), "utf8");
    assert.ok(preload.includes(JSON.stringify(path.join(source.engine, "resources/app.asar/node_modules"))));

    // A corrupt cache is replaced without overwriting a possibly running copy.
    await writeFile(first, Buffer.alloc(original.length, 0));
    const recovered = await prepareBaiduCdpLauncher(source.executable, cache);
    assert.notEqual(recovered, first);
    assert.equal(digest(await readFile(recovered)), digest(original));
    assert.equal((await readFile(first))[0], 0);
  } finally { await removeFixture(root); }
});

test("reads different client versions and entry layouts and rebuilds after updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-cdp-versions-"));
  try {
    const legacy = await fixture(root, "旧版 client", "main.js", "8.8.0");
    const current = await fixture(root, "current");
    const cache = path.join(root, "cache");
    const oldLauncher = await prepareBaiduCdpLauncher(legacy.executable, cache);
    const newLauncher = await prepareBaiduCdpLauncher(current.executable, cache);
    const oldMain = await readFile(path.join(path.dirname(oldLauncher), "resources/app/main.cjs"), "utf8");
    const newMain = await readFile(path.join(path.dirname(newLauncher), "resources/app/main.cjs"), "utf8");
    assert.ok(oldMain.includes(JSON.stringify(path.join(legacy.engine, "resources/app.asar/main.js"))));
    assert.ok(newMain.includes(JSON.stringify(path.join(current.engine, "resources/app.asar/dist/electron/entry.js"))));
    await writeFile(path.join(current.engine, "browserengine.dll"), "native runtime v2, updated");
    assert.notEqual(await prepareBaiduCdpLauncher(current.executable, cache), newLauncher);

    await writeFile(path.join(current.app, "package.json"), JSON.stringify({ name: "baidunetdisk", version: "9.0.0", main: "new-entry.js" }));
    await writeFile(path.join(current.app, "new-entry.js"), "module.exports = 'updated';");
    await createPackage(current.app, path.join(current.engine, "resources/app.asar"));
    const updated = await prepareBaiduCdpLauncher(current.executable, cache);
    const updatedMain = await readFile(path.join(path.dirname(updated), "resources/app/main.cjs"), "utf8");
    assert.ok(updatedMain.includes(JSON.stringify(path.join(current.engine, "resources/app.asar/new-entry.js"))));
  } finally { await removeFixture(root); }
});

test("concurrent preparation shares one result and refuses a cache in the client installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-cdp-concurrent-"));
  try {
    const source = await fixture(root);
    const cache = path.join(root, "cache");
    const results = await Promise.all(Array.from({ length: 3 }, () => prepareBaiduCdpLauncher(source.executable, cache)));
    assert.equal(new Set(results).size, 1);
    await assert.rejects(prepareBaiduCdpLauncher(source.executable, path.join(source.engine, "cache")), /CACHE_INVALID/);
    await assert.rejects(readFile(path.join(source.engine, "cache", ".ready")), /ENOENT/);
  } finally { await removeFixture(root); }
});

test("the launcher preserves native paths and existing preloads, and restores command-line methods", () => {
  const options = {
    sourceExecutable: path.resolve("client/BaiduNetdiskUnite.exe"),
    sourceApp: path.resolve("client/resources/app.asar"),
    sourceEntry: path.resolve("client/resources/app.asar/custom-entry.js"),
    preloadPath: path.resolve("cache/resources/app/preload.cjs"),
  };
  const { main, preload } = baiduLauncherSources(options);
  const removed: string[] = [];
  const originalRemove = (name: string) => removed.push(name);
  const locations = new Map<string, string>();
  let sessionCreated: (session: unknown) => void = () => {};
  let preloads: string[] = [];
  const app = {
    commandLine: { removeSwitch: originalRemove },
    setPath: (name: string, value: string) => locations.set(name, value),
    setAppPath: (value: string) => locations.set("app", value),
    on: (name: string, callback: typeof sessionCreated) => { assert.equal(name, "session-created"); sessionCreated = callback; },
  };
  const process = { env: {} as Record<string, string> };
  runInNewContext(main, { process, require: (name: string) => {
    if (name === "electron") return { app };
    assert.equal(name, options.sourceEntry);
    app.commandLine.removeSwitch("remote-debugging-port");
    app.commandLine.removeSwitch("remote-debugging-pipe");
    app.commandLine.removeSwitch("disable-gpu");
  } });
  assert.deepEqual(removed, ["disable-gpu"]);
  assert.equal(app.commandLine.removeSwitch, originalRemove);
  assert.equal(locations.get("exe"), options.sourceExecutable);
  assert.equal(locations.get("app"), options.sourceApp);
  sessionCreated({ getPreloads: () => ["original-preload"], setPreloads: (value: string[]) => { preloads = value; } });
  assert.deepEqual(Array.from(preloads), ["original-preload", options.preloadPath]);
  let pathsInitialized = false;
  runInNewContext(preload, { process: { env: process.env }, require: () => ({ Module: { _initPaths: () => { pathsInitialized = true; } } }) });
  assert.equal(pathsInitialized, true);
  assert.equal(process.env.NODE_PATH, path.join(options.sourceApp, "node_modules"));
});

test("Mac launcher leaves the vendor bundle intact and loads an external entry with the matching runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-cdp-mac-"));
  try {
    const contents = path.join(root, "安装位置", "BaiduNetdisk.app", "Contents");
    const executable = path.join(contents, "MacOS", "BaiduNetdisk");
    const app = path.join(root, "source-app");
    const resources = path.join(contents, "Resources");
    const framework = path.join(contents, "Frameworks", "Electron Framework.framework", "Electron Framework");
    for (const dir of [path.dirname(executable), path.dirname(framework), resources, app]) await mkdir(dir, { recursive: true });
    await writeFile(executable, "signed executable");
    await writeFile(framework, "signed framework");
    await writeFile(path.join(contents, "Info.plist"), "original signed plist");
    await writeFile(path.join(resources, "core.asar"), "native core");
    await writeFile(path.join(resources, "icon.icns"), "icon");
    await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "baidunetdisk", version: "8.9.7", main: "entry.js" }));
    await writeFile(path.join(app, "entry.js"), "module.exports = 'client';");
    await createPackage(app, path.join(resources, "app.asar"));
    const cache = path.join(root, "cache");
    const runtimePath = path.join(root, "runtime", "Electron.app", "Contents", "MacOS", "Electron");
    const versions: string[] = [];
    const dependencies = {
      version: async () => "26.2.0",
      runtime: async (version: string) => { versions.push(version); return runtimePath; },
    };
    const prepare = (target = cache) => prepareMacBaiduCdpLauncher(executable, target, options => baiduLauncherSources({ ...options, cdpPort: 9440 }), dependencies);
    const first = await prepare();
    assert.equal(first.executable, runtimePath);
    assert.deepEqual(versions, ["26.2.0"]);
    assert.equal(first.args[1], "--dramabridge-baidu-netdisk");
    const externalApp = first.args[0]!;
    assert.ok(externalApp.startsWith(cache + path.sep));
    const main = await readFile(path.join(externalApp, "main.cjs"), "utf8");
    assert.ok(main.includes("const port = 9440"));
    assert.ok(main.includes("mac-profile"));
    await assert.rejects(readFile(path.join(externalApp, "Contents", "MacOS", "BaiduNetdisk")), /ENOENT/);
    assert.deepEqual(await prepare(), first);
    await writeFile(path.join(externalApp, "main.cjs"), "corrupted");
    assert.notEqual((await prepare()).args[0], externalApp);
    await assert.rejects(prepare(path.join(contents, "cache")), /CACHE_INVALID/);
    await writeFile(path.join(resources, "core.asar"), "updated native core");
    assert.notEqual((await prepare()).args[0], externalApp);
    assert.equal(await readFile(executable, "utf8"), "signed executable");
    assert.equal(await readFile(framework, "utf8"), "signed framework");
  } finally { await removeFixture(root); }
});

test("Mac entry enables configured loopback CDP without depending on stripped argv", () => {
  const options = { sourceExecutable: "/Applications/BaiduNetdisk.app/Contents/MacOS/BaiduNetdisk", sourceApp: "/client/app.asar", sourceEntry: "/client/app.asar/main.js", preloadPath: "/cache/preload.cjs", cdpPort: 9440 };
  const switches: Array<[string, string]> = [];
  let loaded = false;
  const app = {
    commandLine: { appendSwitch: (name: string, value: string) => switches.push([name, value]), removeSwitch: () => {} },
    setPath: () => {}, setAppPath: () => {}, on: () => {},
  };
  const run = (cdpPort: number) => runInNewContext(baiduLauncherSources({ ...options, cdpPort }).main, {
    process: { platform: "darwin", argv: [] },
    require: (name: string) => {
      if (name === "electron") return { app };
      assert.deepEqual(switches, [["remote-debugging-port", "9440"], ["remote-debugging-address", "127.0.0.1"]]);
      loaded = true;
    },
  });
  run(9440);
  assert.equal(loaded, true);
  assert.throws(() => run(0), /PORT_INVALID/);
  assert.throws(() => run(65536), /PORT_INVALID/);
});
