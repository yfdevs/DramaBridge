import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeBaiduMd5 } from "../domain/file-checksum.js";

export const uploadBlockSize = 4 * 1024 * 1024;
export type UploadFileIdentity = { size: number; modifiedAtMs: number; md5: string; hashes: string[] };
export type RemoteUploadEntry = { server_filename: string; path: string; isdir: number; size: number; md5?: string; fs_id?: number | string; server_mtime?: number };

export function assertRecreationVersionDirectory(directory: string) {
  const parts = directory.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "快手_二创集合" || !parts[2].endsWith("-60%")
    || parts.some(part => part === "." || part === "..") || directory !== "/" + parts.join("/"))
    throw new Error("无效的二创版本目录");
}

export function isLegacySummaryDirectory(candidate: string, canonical: string) {
  const prefix = canonical + "汇总";
  return candidate === prefix || (candidate.startsWith(prefix) && /^（[1-9]\d*）$/.test(candidate.slice(prefix.length)));
}

export async function planUploadDirectory(options: {
  localDirectory: string;
  remoteDirectory: string;
  preferredRemoteDirectory?: string;
  list: (directory: string) => Promise<RemoteUploadEntry[]>;
  signal?: AbortSignal;
  verifyFile?: (file: RemoteUploadEntry, identity: UploadFileIdentity) => Promise<boolean>;
}) {
  assertRecreationVersionDirectory(options.remoteDirectory);
  const identities = new Map<string, UploadFileIdentity>();
  const tree = new Map<string, Array<{ name: string; directory: boolean }>>();
  const scan = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    tree.set(directory, entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() })));
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const local = path.join(directory, entry.name);
      if (entry.isDirectory()) { await scan(local); continue; }
      if (!entry.isFile()) throw new Error("不支持上传符号链接素材");
      const info = await stat(local);
      if (!info.size) throw new Error(`素材文件为空：${local}`);
      const handle = await open(local, "r");
      try {
        const fullHash = createHash("md5");
        const hashes: string[] = [];
        for (let position = 0; position < info.size; position += uploadBlockSize) {
          options.signal?.throwIfAborted();
          const buffer = Buffer.alloc(Math.min(uploadBlockSize, info.size - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead !== buffer.length) throw new Error(`素材文件在校验中发生变化：${local}`);
          fullHash.update(buffer);
          hashes.push(createHash("md5").update(buffer).digest("hex"));
        }
        identities.set(local, { size: info.size, modifiedAtMs: info.mtimeMs, md5: fullHash.digest("hex"), hashes });
      } finally { await handle.close(); }
    }
  };
  await scan(options.localDirectory);
  if (!identities.size) throw new Error("上传目录中没有文件");
  const inspect = async (local: string, remote: string): Promise<{ conflicts: RemoteUploadEntry[]; verifiedCount: number }> => {
    options.signal?.throwIfAborted();
    const entries = tree.get(local)!;
    const cloud = await options.list(remote);
    const conflicts: RemoteUploadEntry[] = [];
    let verifiedCount = 0;
    for (const file of cloud) {
      if (file.path !== path.posix.join(remote, file.server_filename)) throw new Error("网盘返回的文件路径不属于当前版本目录");
      const entry = entries.find(entry => entry.name === file.server_filename);
      if (!entry || entry.directory !== Boolean(file.isdir)) { conflicts.push(file); continue; }
      const source = path.join(local, entry.name);
      if (entry.directory) {
        const nested = await inspect(source, file.path);
        conflicts.push(...nested.conflicts);
        verifiedCount += nested.verifiedCount;
      } else {
        const identity = identities.get(source)!;
        if (file.size !== identity.size || (normalizeBaiduMd5(file.md5) !== identity.md5 && (!options.verifyFile || !(await options.verifyFile(file, identity))))) conflicts.push(file);
        else verifiedCount++;
      }
    }
    return { conflicts, verifiedCount };
  };
  const parent = path.posix.dirname(options.remoteDirectory);
  const siblings = await options.list(parent);
  const existing = siblings.find(entry => entry.path === options.remoteDirectory);
  const canonical = existing?.isdir ? await inspect(options.localDirectory, options.remoteDirectory)
    : { conflicts: existing ? [existing] : [], verifiedCount: 0 };
  const legacyDirectories = siblings.filter(entry => entry.isdir && isLegacySummaryDirectory(entry.path, options.remoteDirectory));
  const preferred = legacyDirectories.find(entry => entry.path === options.preferredRemoteDirectory);
  let reuseFrom: RemoteUploadEntry | undefined;
  let conflicts = canonical.conflicts;
  for (const candidate of preferred ? [preferred, ...legacyDirectories.filter(entry => entry !== preferred)] : legacyDirectories) {
    const legacy = await inspect(options.localDirectory, candidate.path);
    if (legacy.verifiedCount > canonical.verifiedCount) {
      reuseFrom = candidate;
      conflicts = legacy.conflicts.map(file => ({ ...file, path: options.remoteDirectory + file.path.slice(candidate.path.length) }));
      break;
    }
  }
  return { remoteDirectory: options.remoteDirectory, identities, conflicts, existing, reuseFrom, legacyDirectories };
}
