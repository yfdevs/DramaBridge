import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { extractFile, uncache } from "@electron/asar";
import { prepareMacElectronRuntime, sha256File } from "./mac-electron-runtime.js";

type Sources = (options: {
  sourceExecutable: string; sourceApp: string; sourceEntry: string; preloadPath: string;
  userDataPath?: string; startupErrorPath?: string;
}) => { main: string; preload: string };

const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const defaultDependencies = {
  version: async (contents: string) => (await execa("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-",
    path.join(contents, "Frameworks", "Electron Framework.framework", "Resources", "Info.plist")])).stdout.trim(),
  runtime: prepareMacElectronRuntime,
};

export type MacBaiduLaunch = { executable: string; args: string[]; startupErrorPath: string };

// An external app directory is loaded by an unchanged, ABI-matched official
// Electron runtime. Copying Baidu's signed .app and replacing its entry breaks
// its resource seal and can produce macOS's "application is damaged" warning.
export async function prepareMacBaiduCdpLauncher(source: string, cacheRoot: string, sourcesFor: Sources,
  dependencies = defaultDependencies): Promise<MacBaiduLaunch> {
  const sourceContents = path.dirname(path.dirname(await realpath(source)));
  const sourceBundle = path.dirname(sourceContents);
  if (!sourceBundle.endsWith(".app") || path.basename(sourceContents) !== "Contents") {
    throw new Error("BAIDU_CDP_LAUNCHER_UNSUPPORTED_BUNDLE: 请选择完整的百度网盘 Mac 应用");
  }
  if (inside(sourceBundle, cacheRoot)) throw new Error("BAIDU_CDP_LAUNCHER_CACHE_INVALID: 启动适配缓存必须位于百度客户端安装目录之外");
  await mkdir(cacheRoot, { recursive: true });
  if (inside(sourceBundle, await realpath(cacheRoot))) throw new Error("BAIDU_CDP_LAUNCHER_CACHE_INVALID: 启动适配缓存不能指向百度客户端安装目录");
  const sourceApp = path.join(sourceContents, "Resources", "app.asar");
  uncache(sourceApp);
  const metadata = JSON.parse(extractFile(sourceApp, "package.json").toString("utf8")) as {
    name?: string; version?: string; productName?: string; main?: string;
  };
  const sourceEntry = path.resolve(sourceApp, metadata.main || "index.js");
  if (sourceEntry === sourceApp || !inside(sourceApp, sourceEntry)) throw new Error("BAIDU_CDP_LAUNCHER_UNSUPPORTED_ENTRY: 百度客户端入口不在应用包内");
  const sourceExecutable = path.join(sourceContents, "MacOS", path.basename(source));
  const version = await dependencies.version(sourceContents);
  const executable = await dependencies.runtime(version, process.arch, path.join(cacheRoot, "mac-runtimes"));
  // The App Store client's protected container is never copied or decrypted.
  // This separate persistent profile may require a first login in the client.
  const userDataPath = path.join(cacheRoot, "mac-profile");
  const startupErrorPath = path.join(cacheRoot, "mac-startup-error.txt");
  const identity = async () => JSON.stringify({
    revision: 3, sourceExecutable, version, executable, appSha256: await sha256File(sourceApp),
    coreSha256: await sha256File(path.join(sourceContents, "Resources", "core.asar")),
    launcher: sourcesFor({ sourceExecutable, sourceApp, sourceEntry, preloadPath: "", userDataPath, startupErrorPath }),
  });
  const originalIdentity = await identity();
  const fingerprint = createHash("sha256").update(originalIdentity).digest("hex").slice(0, 24);
  let directory = path.join(cacheRoot, `mac-${fingerprint}`);
  const packageJson = JSON.stringify({ name: metadata.name || "baidunetdisk", version: metadata.version || "0.0.0", productName: metadata.productName, main: "main.cjs" });
  const sourcesAt = (dir: string) => sourcesFor({ sourceExecutable, sourceApp, sourceEntry, preloadPath: path.join(dir, "app", "preload.cjs"), userDataPath, startupErrorPath });
  const launchAt = (dir: string) => ({ executable, args: [path.join(dir, "app"), "--dramabridge-baidu-netdisk"], startupErrorPath });
  try {
    const sources = sourcesAt(directory);
    if (await readFile(path.join(directory, ".ready"), "utf8") === fingerprint
      && await readFile(path.join(directory, "app", "main.cjs"), "utf8") === sources.main
      && await readFile(path.join(directory, "app", "preload.cjs"), "utf8") === sources.preload
      && await readFile(path.join(directory, "app", "package.json"), "utf8") === packageJson) return launchAt(directory);
  } catch { /* Build a complete entry before allowing a restart. */ }
  if (await stat(directory).then(() => true, () => false)) directory += `-${randomUUID()}`;
  await mkdir(path.join(directory, "app"), { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  const sources = sourcesAt(directory);
  await writeFile(path.join(directory, "app", "package.json"), packageJson);
  await writeFile(path.join(directory, "app", "main.cjs"), sources.main);
  await writeFile(path.join(directory, "app", "preload.cjs"), sources.preload);
  if (await identity() !== originalIdentity) throw new Error("BAIDU_CDP_LAUNCHER_SOURCE_CHANGED: 百度客户端正在更新，请更新完成后重新启动");
  await writeFile(path.join(directory, ".ready.tmp"), fingerprint);
  await rename(path.join(directory, ".ready.tmp"), path.join(directory, ".ready"));
  return launchAt(directory);
}
