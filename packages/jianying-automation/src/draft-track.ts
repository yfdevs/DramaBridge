import { pathExists, temporaryWriteTask } from "@dramabridge/file-utils";
import { execa } from "execa";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type JianyingDraftTrackResult = {
  success: true;
  mediaLibraryWritten: true;
  videoCount: number;
  duration: number;
  segmentDurations: number[];
  subtitleFreeTimelineTime: number | null;
  subtitleTrackSegmentCount: number;
  subtitleGapCount: number;
  subtitleFreeRanges: Array<[number, number]>;
  removedMissingAudioCount: number;
  sha256: string;
  updatedFiles: string[];
};

function processResourcesPath() {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

export async function resolveJianyingDraftWorkerPath() {
  const resourcesPath = processResourcesPath();
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.JIANYING_DRAFT_WORKER_PATH,
    resourcesPath && path.join(resourcesPath, "jianying-automation", "JianyingDraftWorker.exe"),
    path.resolve(process.cwd(), "packages", "jianying-automation", "native", "bin", "JianyingDraftWorker.exe"),
    path.resolve(sourceDirectory, "..", "native", "bin", "JianyingDraftWorker.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("剪映草稿轨道组件未构建");
}

function parseWorkerOutput(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]!) as JianyingDraftTrackResult | {
        success: false;
        message?: string;
      };
    } catch {
      // Native codec diagnostics may be printed before the final JSON result.
    }
  }
  return null;
}

function decodeWorkerOutput(output: string | Uint8Array | undefined) {
  if (!output) return "";
  if (typeof output === "string") return output;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return new TextDecoder("gb18030").decode(output);
  }
}

async function resolveCodecInstallDirectory(installDirectory: string) {
  const requestedDirectory = path.resolve(installDirectory);
  const candidates = [requestedDirectory];
  const entries = await readdir(requestedDirectory, { withFileTypes: true }).catch(() => []);
  const versionDirectories = entries
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map((entry) => path.join(requestedDirectory, entry.name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  candidates.push(...versionDirectories);

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "videoeditor.dll"))) return candidate;
  }
  throw new Error("未找到剪映草稿组件，请确认剪映安装完整");
}

export async function writeJianyingDraftVideoTrack(input: {
  draftPath: string;
  installDirectory: string;
  segmentFiles: string[];
  preferredTimelineTime?: number;
  registerAsNewDraft?: boolean;
}) {
  if (process.platform !== "win32") throw new Error("剪映草稿写入仅支持 Windows");
  if (!input.segmentFiles.length) throw new Error("没有可写入轨道的分段视频");

  const workerPath = await resolveJianyingDraftWorkerPath();
  const codecInstallDirectory = await resolveCodecInstallDirectory(input.installDirectory);
  const workerInput = JSON.stringify({
    segments: input.segmentFiles,
    preferredTimelineTime: input.preferredTimelineTime,
  });
  return temporaryWriteTask(workerInput, async (inputPath) => {
    let stdout: string;
    try {
      const result = await execa(workerPath, [
        "write-track",
        "--draft",
        path.resolve(input.draftPath),
        "--install-dir",
        codecInstallDirectory,
        "--input",
        inputPath,
        ...(input.registerAsNewDraft ? ["--register-as-new-draft"] : []),
      ], {
        encoding: "buffer",
        timeout: 5 * 60_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = decodeWorkerOutput(result.stdout);
    } catch (error) {
      const output = decodeWorkerOutput((error as { stdout?: string | Buffer }).stdout);
      const result = parseWorkerOutput(output);
      throw Object.assign(
        new Error(result && !result.success && result.message
          ? result.message
          : "剪映草稿轨道写入失败"),
        { cause: error },
      );
    }

    const result = parseWorkerOutput(stdout);
    if (!result) throw new Error("剪映草稿轨道组件返回了无效结果");
    if (!result.success) throw new Error(result.message ?? "剪映草稿轨道写入失败");
    if (result.videoCount !== input.segmentFiles.length) {
      throw new Error("写入草稿的视频片段数量不一致");
    }
    return result;
  }, { extension: "json", parentDirectory: "dramabridge" });
}
