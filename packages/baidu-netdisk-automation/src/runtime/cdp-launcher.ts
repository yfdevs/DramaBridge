import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractFile, uncache } from "@electron/asar";

const launcherRevision = 1;
const preparations = new Map<string, Promise<string>>();

export function baiduLauncherSources(options: {
  sourceExecutable: string;
  sourceApp: string;
  sourceEntry: string;
  preloadPath: string;
}) {
  const resources = path.dirname(options.sourceApp);
  const preload = `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} });
process.env.NODE_PATH = ${JSON.stringify(path.join(options.sourceApp, "node_modules"))};
require('module').Module._initPaths();
`;
  const main = `const { app } = require('electron');
// Keep native helpers, login data and update paths on the installed client.
app.setPath('exe', ${JSON.stringify(options.sourceExecutable)});
Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(options.sourceExecutable)} });
Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} });
app.setAppPath(${JSON.stringify(options.sourceApp)});
app.on('session-created', session => {
  if (typeof session.setPreloads !== 'function' || typeof session.getPreloads !== 'function') {
    throw new Error('BAIDU_CDP_LAUNCHER_UNSUPPORTED_SESSION: 此客户端缺少启动适配所需的预加载接口');
  }
  session.setPreloads([...session.getPreloads(), ${JSON.stringify(options.preloadPath)}]);
});
const removeSwitch = app.commandLine.removeSwitch;
app.commandLine.removeSwitch = function(name) {
  if (name === 'remote-debugging-port' || name === 'remote-debugging-pipe') return;
  return removeSwitch.call(this, name);
};
try {
  require(${JSON.stringify(options.sourceEntry)});
} finally {
  app.commandLine.removeSwitch = removeSwitch;
}
`;
  return { main, preload };
}

async function fingerprintFile(file: string) {
  const info = await stat(file);
  return { name: path.basename(file), size: info.size, modified: info.mtimeMs };
}

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function prepare(sourceExecutable: string, cacheRoot: string) {
  const sourceDir = path.dirname(sourceExecutable);
  const relativeCache = path.relative(sourceDir, cacheRoot);
  if (!relativeCache || (!relativeCache.startsWith("..") && !path.isAbsolute(relativeCache))) {
    throw new Error("BAIDU_CDP_LAUNCHER_CACHE_INVALID: 启动适配缓存必须位于百度客户端安装目录之外");
  }
  const sourceApp = path.join(sourceDir, "resources", "app.asar");
  // Read the installed package metadata rather than assuming a particular
  // Baidu version or entry script layout. Clear ASAR's own header cache first.
  uncache(sourceApp);
  const metadata = JSON.parse(extractFile(sourceApp, "package.json").toString("utf8")) as {
    name?: string; version?: string; productName?: string; main?: string;
  };
  const mainEntry = metadata.main || "index.js";
  const sourceEntry = path.resolve(sourceApp, mainEntry);
  const relativeEntry = path.relative(sourceApp, sourceEntry);
  if (!relativeEntry || relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
    throw new Error("BAIDU_CDP_LAUNCHER_UNSUPPORTED_ENTRY: 百度客户端入口不在应用包内");
  }
  const rootEntries = await readdir(sourceDir, { withFileTypes: true });
  const runtimeFiles = rootEntries.filter(entry => entry.isFile() && !/\.old$|\.log$|LICENSE/i.test(entry.name));
  const identities = await Promise.all(runtimeFiles.map(entry => fingerprintFile(path.join(sourceDir, entry.name))));
  const sourceHash = await sha256(sourceExecutable);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    revision: launcherRevision, sourceExecutable, sourceHash, identities,
    app: await fingerprintFile(sourceApp),
    core: await fingerprintFile(path.join(sourceDir, "resources", "core.asar")).catch(() => undefined),
    locales: await fingerprintFile(path.join(sourceDir, "locales")).catch(() => undefined),
  })).digest("hex").slice(0, 24);
  let directory = path.join(cacheRoot, fingerprint);
  const executableName = path.basename(sourceExecutable);
  const sourcesFor = (dir: string) => baiduLauncherSources({
    sourceExecutable, sourceApp, sourceEntry,
    preloadPath: path.join(dir, "resources", "app", "preload.cjs"),
  });
  const isReusable = async () => {
    try {
      const sources = sourcesFor(directory);
      return await readFile(path.join(directory, ".ready"), "utf8") === fingerprint
        && await sha256(path.join(directory, executableName)) === sourceHash
        && await readFile(path.join(directory, "resources", "app", "main.cjs"), "utf8") === sources.main
        && await readFile(path.join(directory, "resources", "app", "preload.cjs"), "utf8") === sources.preload
        && (await Promise.all(identities.map(async identity =>
          (await stat(path.join(directory, identity.name))).size === identity.size))).every(Boolean);
    } catch { return false; }
  };
  if (await isReusable()) return path.join(directory, executableName);
  // Never overwrite a launcher that another client process might be running.
  if (await stat(directory).then(() => true, () => false)) directory += `-${randomUUID()}`;
  await mkdir(path.join(directory, "resources", "app"), { recursive: true });
  for (const entry of runtimeFiles) await copyFile(path.join(sourceDir, entry.name), path.join(directory, entry.name));
  if (await stat(path.join(sourceDir, "locales")).then(() => true, () => false)) {
    await cp(path.join(sourceDir, "locales"), path.join(directory, "locales"), { recursive: true });
  }
  const sources = sourcesFor(directory);
  await writeFile(path.join(directory, "resources", "app", "main.cjs"), sources.main);
  await writeFile(path.join(directory, "resources", "app", "preload.cjs"), sources.preload);
  await writeFile(path.join(directory, "resources", "app", "package.json"), JSON.stringify({
    name: metadata.name || "baidunetdisk", version: metadata.version || "0.0.0",
    productName: metadata.productName, main: "main.cjs",
  }));
  if (await sha256(path.join(directory, executableName)) !== sourceHash
    || await sha256(sourceExecutable) !== sourceHash
    || JSON.stringify(await Promise.all(runtimeFiles.map(entry => fingerprintFile(path.join(sourceDir, entry.name))))) !== JSON.stringify(identities)) {
    throw new Error("BAIDU_CDP_LAUNCHER_SOURCE_CHANGED: 百度客户端正在更新，请更新完成后重新启动");
  }
  await writeFile(path.join(directory, ".ready.tmp"), fingerprint);
  await rename(path.join(directory, ".ready.tmp"), path.join(directory, ".ready"));
  return path.join(directory, executableName);
}

export function prepareBaiduCdpLauncher(sourceExecutable: string, cacheRoot: string): Promise<string> {
  const source = path.resolve(sourceExecutable);
  const root = path.resolve(cacheRoot);
  const key = `${source}\n${root}`;
  const existing = preparations.get(key);
  if (existing) return existing;
  const pending = prepare(source, root).finally(() => preparations.delete(key));
  preparations.set(key, pending);
  return pending;
}
