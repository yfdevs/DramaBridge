import { cleanupStaleRuntimeArtifacts } from "@dramabridge/media-assets";
import path from "node:path";
import { logMain } from "./main-logger";

type RuntimeAssetCleanupRoot = {
  platform: string;
  rootPath: string;
  maxDepth: number;
  retentionMs: number;
};

export type RuntimeAssetCleanupRunOptions = {
  reason: "startup" | "scheduled" | "disk-pressure" | "manual";
  diskPressure?: boolean;
  dryRun?: boolean;
};

const cleanupRoots = new Map<string, RuntimeAssetCleanupRoot>();
const scheduledCleanupIntervalMs = 60 * 60 * 1000;
const diskPressureMinimumAgeMs = 2 * 60 * 60 * 1000;
let scheduledCleanupTimer: NodeJS.Timeout | null = null;
let cleanupOperation: Promise<void> | null = null;

export function registerRuntimeAssetCleanupRoot(root: RuntimeAssetCleanupRoot) {
  cleanupRoots.set(root.platform, {
    ...root,
    rootPath: path.resolve(root.rootPath),
    maxDepth: Math.max(1, root.maxDepth),
    retentionMs: Math.max(diskPressureMinimumAgeMs, root.retentionMs),
  });
}

export function runRuntimeAssetCleanup(options: RuntimeAssetCleanupRunOptions) {
  if (cleanupOperation) return cleanupOperation;

  cleanupOperation = (async () => {
    for (const root of cleanupRoots.values()) {
      try {
        const result = await cleanupStaleRuntimeArtifacts({
          rootPath: root.rootPath,
          maxDepth: root.maxDepth,
          minimumAgeMs: options.diskPressure
            ? diskPressureMinimumAgeMs
            : root.retentionMs,
          dryRun: options.dryRun,
        });

        if (result.deletedDirectoryCount > 0 || result.failures.length > 0) {
          logMain(
            result.failures.length > 0 ? "warn" : "info",
            options.dryRun
              ? "Runtime asset cleanup preview completed"
              : "Runtime asset cleanup completed",
            {
              platform: root.platform,
              reason: options.reason,
              rootPath: result.rootPath,
              candidates: result.candidateCount,
              active: result.activeCount,
              young: result.youngCount,
              deleted: result.deletedDirectoryCount,
              reclaimedLogicalBytes: result.reclaimedLogicalBytes,
              failures: result.failures,
            },
            "storage",
          );
        }
      } catch (error) {
        logMain(
          "warn",
          "Runtime asset cleanup failed",
          { platform: root.platform, reason: options.reason, rootPath: root.rootPath, error },
          "storage",
        );
      }
    }
  })().finally(() => {
    cleanupOperation = null;
  });

  return cleanupOperation;
}

export function startRuntimeAssetCleanupMonitor() {
  if (scheduledCleanupTimer) return;
  void runRuntimeAssetCleanup({ reason: "startup" });
  scheduledCleanupTimer = setInterval(() => {
    void runRuntimeAssetCleanup({ reason: "scheduled" });
  }, scheduledCleanupIntervalMs);
  scheduledCleanupTimer.unref();
}
