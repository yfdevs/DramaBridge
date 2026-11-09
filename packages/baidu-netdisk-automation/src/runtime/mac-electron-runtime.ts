import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import { log } from "../infrastructure/logging.js";
import { artifactFileSystem } from "./artifact-filesystem.js";

const { createReadStream } = artifactFileSystem;
const { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } = artifactFileSystem.promises;

const pending = new Map<string, Promise<string>>();

export async function sha256File(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function officialElectronArtifact(version: string, arch: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !["arm64", "x64"].includes(arch)) {
    throw new Error("BAIDU_CDP_RUNTIME_UNSUPPORTED: 不支持此百度客户端运行时版本或 Mac 架构");
  }
  const name = `electron-v${version}-darwin-${arch}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${version}/`;
  return { name, archiveUrl: base + name, checksumUrl: base + "SHASUMS256.txt" };
}

export function electronArtifactChecksum(text: string, name: string) {
  const match = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim()))
    .find(item => item?.[2] === name);
  if (!match) throw new Error("BAIDU_CDP_RUNTIME_CHECKSUM_MISSING: 官方校验文件未包含所需运行时");
  return match[1]!;
}

async function runtimeIdentity(root: string): Promise<string> {
  const files: Array<[string, string]> = [];
  const walk = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) files.push([relative, `link:${await readlink(full)}`]);
      else if (entry.isFile()) files.push([relative, await sha256File(full)]);
    }
  };
  await walk(path.join(root, "Electron.app"));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

const runtimeDependencies = {
  download: async (url: string, destination: string) => {
    // curl uses the system's proxy configuration/environment at this tooling
    // boundary. Both the initial URL and every redirect must use HTTPS.
    await execa("/usr/bin/curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "20", "--max-time", "600", "--silent", "--show-error", "--output", destination, url], { timeout: 610_000 });
  },
  extract: async (archive: string, directory: string) => {
    await execa("/usr/bin/ditto", ["-x", "-k", archive, directory], { timeout: 120_000 });
  },
};

/** Use the exact native ABI version from the installed framework, never the
 * host application's newer Electron, and never modify/re-sign Baidu's bundle.
 */
export function prepareMacElectronRuntime(version: string, arch: string, cacheRoot: string, dependencies: typeof runtimeDependencies & {
  cleanup?: (directory: string) => Promise<void>;
} = runtimeDependencies): Promise<string> {
  const artifact = officialElectronArtifact(version, arch);
  const key = `${cacheRoot}\n${version}\n${arch}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async () => {
    await mkdir(cacheRoot, { recursive: true });
    let directory = path.join(cacheRoot, `electron-${version}-${arch}`);
    const executable = (root: string) => path.join(root, "Electron.app", "Contents", "MacOS", "Electron");
    try {
      const marker = JSON.parse(await readFile(path.join(directory, ".ready"), "utf8"));
      if (marker.version === version && marker.arch === arch && marker.identity === await runtimeIdentity(directory)
        && (await stat(executable(directory))).isFile()) return executable(directory);
    } catch { /* A missing/incomplete/corrupt cache must never be launched. */ }
    if (await stat(directory).then(() => true, () => false)) directory += `-${randomUUID()}`;
    const staging = path.join(cacheRoot, `.prepare-${randomUUID()}`);
    await mkdir(staging);
    try {
      log("正在准备百度网盘 Mac 运行时，首次连接需要下载官方 Electron", { version, arch });
      const archive = path.join(staging, artifact.name);
      const checksums = path.join(staging, "SHASUMS256.txt");
      await dependencies.download(artifact.checksumUrl, checksums);
      const expected = electronArtifactChecksum(await readFile(checksums, "utf8"), artifact.name);
      await dependencies.download(artifact.archiveUrl, archive);
      if (await sha256File(archive) !== expected) throw new Error("BAIDU_CDP_RUNTIME_CHECKSUM_MISMATCH: 运行时下载校验失败，已停止启动");
      await dependencies.extract(archive, staging);
      if (!(await stat(executable(staging))).isFile()) throw new Error("BAIDU_CDP_RUNTIME_INVALID: 下载的运行时缺少启动文件");
      await writeFile(path.join(staging, ".ready"), JSON.stringify({ version, arch, archiveSha256: expected, identity: await runtimeIdentity(staging) }));
      await rm(archive);
      await rename(staging, directory);
      return executable(directory);
    } catch (error) {
      try {
        if (dependencies.cleanup) await dependencies.cleanup(staging);
        else await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (cleanupError) {
        // Cleanup is secondary. Preserve download/extraction/checksum errors
        // so callers see the actual reason preparation failed.
        log("百度网盘 Mac 运行时临时目录清理失败，已保留原始启动错误", {
          staging, cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
  })().finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}
