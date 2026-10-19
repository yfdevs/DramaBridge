import { hostname } from "node:os";
import path from "node:path";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { removePathWithRetry } from "./filesystem-retry.js";

export const episodeUploadDirectoryPattern = /^episode-upload-\d+$/;
export const materialUploadDirectoryPattern = /^material-upload(?:-task-.*)?$/;
export const runtimeArtifactLeaseFileName = ".drama-artifact-lease.json";

type RuntimeArtifactLease = {
  version: 1;
  kind: "episode-upload" | "material-upload";
  pid: number;
  hostname: string;
  createdAt: string;
};

export type RuntimeArtifactCleanupOptions = {
  rootPath: string;
  maxDepth?: number;
  minimumAgeMs: number;
  dryRun?: boolean;
  nowMs?: number;
};

export type RuntimeArtifactCleanupFailure = {
  path: string;
  message: string;
};

export type RuntimeArtifactCleanupResult = {
  rootPath: string;
  scannedDirectoryCount: number;
  candidateCount: number;
  activeCount: number;
  youngCount: number;
  deletedDirectoryCount: number;
  reclaimedLogicalBytes: number;
  failures: RuntimeArtifactCleanupFailure[];
};

type ArtifactDirectoryInfo = {
  latestModifiedAtMs: number;
  logicalBytes: number;
};

function resolvedContainedPath(rootPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Runtime artifact path is outside its cleanup root: ${resolvedTarget}`);
  }
  return { resolvedRoot, resolvedTarget };
}

function validateCleanupRoot(rootPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error(`Refusing to use a filesystem root as an artifact cleanup root: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLease(directoryPath: string) {
  const leasePath = path.join(directoryPath, runtimeArtifactLeaseFileName);
  try {
    const raw = await readFile(leasePath, "utf8");
    const lease = JSON.parse(raw) as Partial<RuntimeArtifactLease>;
    if (
      lease.version !== 1 ||
      (lease.kind !== "episode-upload" && lease.kind !== "material-upload") ||
      typeof lease.pid !== "number" ||
      typeof lease.hostname !== "string" ||
      typeof lease.createdAt !== "string"
    ) {
      return undefined;
    }
    return lease as RuntimeArtifactLease;
  } catch {
    return undefined;
  }
}

async function inspectArtifactDirectory(directoryPath: string): Promise<ArtifactDirectoryInfo> {
  const rootStat = await stat(directoryPath);
  let latestModifiedAtMs = rootStat.mtimeMs;
  let logicalBytes = 0;
  const pending = [directoryPath];

  while (pending.length > 0) {
    const currentPath = pending.pop()!;
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const entryStat = await lstat(entryPath);
      latestModifiedAtMs = Math.max(latestModifiedAtMs, entryStat.mtimeMs);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        pending.push(entryPath);
      } else if (entryStat.isFile()) {
        logicalBytes += entryStat.size;
      }
    }
  }

  return { latestModifiedAtMs, logicalBytes };
}

async function findEpisodeUploadDirectories(rootPath: string, maxDepth: number) {
  const candidates: string[] = [];
  const pending: Array<{ directoryPath: string; depth: number }> = [
    { directoryPath: rootPath, depth: 0 },
  ];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current.directoryPath, { withFileTypes: true }).catch(
      () => undefined,
    );
    if (!entries) continue;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === ".artifact-trash") continue;

      const entryPath = path.join(current.directoryPath, entry.name);
      if (
        episodeUploadDirectoryPattern.test(entry.name)
        || materialUploadDirectoryPattern.test(entry.name)
      ) {
        candidates.push(entryPath);
        continue;
      }
      if (current.depth + 1 < maxDepth) {
        pending.push({ directoryPath: entryPath, depth: current.depth + 1 });
      }
    }
  }

  return candidates;
}

async function removeQuarantinedDirectory(directoryPath: string) {
  await removePathWithRetry(
    directoryPath,
    { recursive: true, force: true, maxRetries: 3, retryDelay: 200 },
    { maximumAttempts: 7, initialDelayMs: 200 },
  );
}

async function cleanupQuarantine(rootPath: string, result: RuntimeArtifactCleanupResult) {
  const trashRoot = path.join(rootPath, ".artifact-trash");
  const entries = await readdir(trashRoot, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(trashRoot, entry.name);
    try {
      resolvedContainedPath(rootPath, entryPath);
      await removeQuarantinedDirectory(entryPath);
    } catch (error) {
      result.failures.push({ path: entryPath, message: errorMessage(error) });
    }
  }
}

export async function createRuntimeArtifactLease(
  directoryPath: string,
  kind: RuntimeArtifactLease["kind"] = "episode-upload",
) {
  const lease: RuntimeArtifactLease = {
    version: 1,
    kind,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(directoryPath, runtimeArtifactLeaseFileName),
    `${JSON.stringify(lease)}\n`,
    "utf8",
  );
}

export async function cleanupStaleRuntimeArtifacts(
  options: RuntimeArtifactCleanupOptions,
): Promise<RuntimeArtifactCleanupResult> {
  const rootPath = validateCleanupRoot(options.rootPath);
  const maxDepth = Math.max(1, Math.min(8, Math.trunc(options.maxDepth ?? 1)));
  const minimumAgeMs = Math.max(0, options.minimumAgeMs);
  const nowMs = options.nowMs ?? Date.now();
  const result: RuntimeArtifactCleanupResult = {
    rootPath,
    scannedDirectoryCount: 0,
    candidateCount: 0,
    activeCount: 0,
    youngCount: 0,
    deletedDirectoryCount: 0,
    reclaimedLogicalBytes: 0,
    failures: [],
  };

  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat) return result;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Runtime artifact cleanup root must be a real directory: ${rootPath}`);
  }

  if (!options.dryRun) await cleanupQuarantine(rootPath, result);
  const candidates = await findEpisodeUploadDirectories(rootPath, maxDepth);
  result.scannedDirectoryCount = candidates.length;

  for (const candidatePath of candidates) {
    result.candidateCount += 1;
    try {
      resolvedContainedPath(rootPath, candidatePath);
      const candidateStat = await lstat(candidatePath);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) continue;

      const lease = await readLease(candidatePath);
      if (lease?.hostname === hostname() && processIsAlive(lease.pid)) {
        result.activeCount += 1;
        continue;
      }

      const info = await inspectArtifactDirectory(candidatePath);
      const leaseCreatedAtMs = lease ? Date.parse(lease.createdAt) : Number.NaN;
      const latestActivityAtMs = Number.isFinite(leaseCreatedAtMs)
        ? Math.max(info.latestModifiedAtMs, leaseCreatedAtMs)
        : info.latestModifiedAtMs;
      if (nowMs - latestActivityAtMs < minimumAgeMs) {
        result.youngCount += 1;
        continue;
      }

      if (options.dryRun) {
        result.deletedDirectoryCount += 1;
        result.reclaimedLogicalBytes += info.logicalBytes;
        continue;
      }

      const trashRoot = path.join(rootPath, ".artifact-trash");
      await mkdir(trashRoot, { recursive: true });
      const quarantinedPath = path.join(
        trashRoot,
        `${path.basename(candidatePath)}-${process.pid}-${Date.now()}`,
      );
      resolvedContainedPath(rootPath, quarantinedPath);
      await rename(candidatePath, quarantinedPath);
      await removeQuarantinedDirectory(quarantinedPath);
      result.deletedDirectoryCount += 1;
      result.reclaimedLogicalBytes += info.logicalBytes;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        result.failures.push({ path: candidatePath, message: errorMessage(error) });
      }
    }
  }

  return result;
}
