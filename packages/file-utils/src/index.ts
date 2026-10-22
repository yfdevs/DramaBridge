import { dirname, isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";

import fg, { type Options as GlobOptions } from "fast-glob";
import filenamify from "filenamify";
import {
  ensureDir,
  move,
  pathExists as fsExtraPathExists,
  readJson,
} from "fs-extra/esm";
import lockfile, { type LockOptions } from "proper-lockfile";
import {
  temporaryDirectory,
  temporaryDirectoryTask,
  temporaryFile,
  temporaryFileTask,
  temporaryWrite,
  temporaryWriteTask,
} from "tempy";
import writeFileAtomic from "write-file-atomic";

export type FindFilesOptions = Omit<GlobOptions, "absolute" | "cwd" | "onlyFiles"> & {
  absolute?: boolean;
  cwd: string;
};

export async function findFiles(
  patterns: string | readonly string[],
  options: FindFilesOptions,
): Promise<string[]> {
  const absolute = options.absolute ?? true;
  const files = await fg.glob(typeof patterns === "string" ? patterns : [...patterns], {
    ...options,
    absolute,
    cwd: options.cwd,
    followSymbolicLinks: options.followSymbolicLinks ?? false,
    onlyFiles: true,
    unique: options.unique ?? true,
  });
  return absolute ? files.map((file) => normalize(file)) : files;
}

export function globPath(filePath: string): string {
  return fg.convertPathToPattern(filePath);
}

export async function walkFiles(root: string, maxDepth = Number.POSITIVE_INFINITY) {
  if (!(await pathExists(root))) return [];
  return findFiles("**/*", {
    cwd: root,
    deep: Number.isFinite(maxDepth) ? maxDepth : undefined,
  });
}

export function pathExists(filePath: string): Promise<boolean> {
  return fsExtraPathExists(filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return readJson(filePath) as Promise<T>;
}

export async function writeTextAtomic(filePath: string, content: string | Buffer): Promise<void> {
  await ensureDir(dirname(filePath));
  await writeFileAtomic(filePath, content);
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { spaces?: number; trailingNewline?: boolean } = {},
): Promise<void> {
  const spaces = options.spaces ?? 2;
  const suffix = options.trailingNewline === false ? "" : "\n";
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, spaces)}${suffix}`);
}

export async function movePath(
  source: string,
  destination: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await ensureDir(dirname(destination));
  await move(source, destination, { overwrite: options.overwrite ?? false });
}

export type SafeFileNameOptions = {
  fallback?: string;
  maxLength?: number;
  replacement?: string;
};

export function safeFileName(value: string, options: SafeFileNameOptions = {}): string {
  const fallback = options.fallback?.trim() || "file";
  // Full-width punctuation is valid in file names. Folding it (for example
  // ， to ,) makes download directories disagree with the original drama title.
  const normalized = value.trim();
  if (!normalized) return fallback;
  return filenamify(normalized, {
    maxLength: options.maxLength ?? 120,
    replacement: options.replacement ?? "-",
  }).trim() || fallback;
}

export function normalizePathKey(filePath: string): string {
  const normalized = normalize(resolve(filePath));
  const withoutTrailingSeparators = normalized === parse(normalized).root
    ? normalized
    : normalized.replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? withoutTrailingSeparators.toLocaleLowerCase("en-US")
    : withoutTrailingSeparators;
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = resolve(parentPath);
  const candidate = resolve(candidatePath);
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function withFileLock<T>(
  targetPath: string,
  task: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  await ensureDir(dirname(targetPath));
  const release = await lockfile.lock(targetPath, {
    realpath: false,
    retries: { factor: 1.5, maxTimeout: 1_000, minTimeout: 100, retries: 5 },
    ...options,
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

export {
  ensureDir,
  temporaryDirectory,
  temporaryDirectoryTask,
  temporaryFile,
  temporaryFileTask,
  temporaryWrite,
  temporaryWriteTask,
};
