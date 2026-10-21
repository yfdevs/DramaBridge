import { pathExists, safeFileName } from "@dramabridge/file-utils";
import { execa } from "execa";
import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export {
  cropJianyingPreviewScreenshot,
  findDramaEpisodes,
  markPreparedEpisodeMediaLibraryWritten,
  markPreparedEpisodeTrackWritten,
  prepareEpisodeDraft,
  readPreparedEpisodeDraft,
  type DramaEpisode,
  type PreparedEpisodeDraft,
} from "./episode-workflow.js";

export {
  resolveJianyingDraftWorkerPath,
  writeJianyingDraftVideoTrack,
  type JianyingDraftTrackResult,
} from "./draft-track.js";

export type JianyingUiaElement = {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  value: string;
  helpText: string;
  legacyName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  enabled: boolean;
  actionable: boolean;
};

export type JianyingUiaProbe = {
  available: boolean;
  operable: boolean;
  processCount: number;
  windowCount: number;
  controlCount: number;
  namedControlCount: number;
  actionableControlCount: number;
  message: string;
  windows: JianyingUiaElement[];
  samples: JianyingUiaElement[];
};

export type JianyingPresetSummary = {
  path: string;
  name: string;
  valid: boolean;
  videoCount: number;
  audioCount: number;
  timelineCount: number;
  hasDraftContent: boolean;
  hasDraftMetadata: boolean;
  draftContentReadable: boolean;
  draftMetadataReadable: boolean;
};

function processResourcesPath() {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

export async function resolveJianyingUiaHelperPath() {
  const resourcesPath = processResourcesPath();
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const developmentCandidates = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp
    ? [
        path.resolve(process.cwd(), "packages", "jianying-automation", "native", "bin", "JianyingUia.exe"),
        path.resolve(sourceDirectory, "..", "native", "bin", "JianyingUia.exe"),
      ]
    : [];
  const candidates = [
    process.env.JIANYING_UIA_HELPER_PATH,
    ...developmentCandidates,
    resourcesPath && path.join(resourcesPath, "jianying-automation", "JianyingUia.exe"),
    path.resolve(process.cwd(), "packages", "jianying-automation", "native", "bin", "JianyingUia.exe"),
    path.resolve(sourceDirectory, "..", "native", "bin", "JianyingUia.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error("剪映 UI Automation Helper 未构建");
}

async function runHelper<T>(args: string[], timeout = 30_000) {
  if (process.platform !== "win32") throw new Error("剪映 UI Automation 仅支持 Windows");
  const helperPath = await resolveJianyingUiaHelperPath();
  const parseOutput = (rawOutput: string) => {
    const output = rawOutput.replace(/^\uFEFF/, "").trim();
    const candidates = [output];
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    candidates.push(...lines.reverse());
    for (const marker of ["{\"success\"", "{\"available\""]) {
      const start = output.lastIndexOf(marker);
      const end = output.lastIndexOf("}");
      if (start >= 0 && end >= start) candidates.push(output.slice(start, end + 1));
    }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as T;
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // Native dependencies can write diagnostics to stdout before the
        // helper's final JSON object. Try the remaining candidates.
      }
    }
    const summary = output.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(
      `剪映辅助程序返回了无效数据（${args[0]}）${summary ? `：${summary}` : ""}`,
    );
  };
  try {
    const { stdout } = await execa(helperPath, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseOutput(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim();
    if (stdout) {
      try {
        const result = parseOutput(stdout) as { message?: string };
        if (result.message) {
          throw Object.assign(new Error(result.message), { cause: error });
        }
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message.startsWith("剪映辅助程序返回了无效数据")) {
          throw parseError;
        }
        throw parseError;
      }
    }
    throw error;
  }
}

export function probeJianyingUia() {
  return runHelper<JianyingUiaProbe>(["probe"]);
}

export function launchJianyingWithUia(input: {
  executablePath: string;
  accessibilityConfigPath?: string | null;
  holdMilliseconds?: number;
}) {
  const args = [
    "launch",
    "--exe",
    input.executablePath,
    "--hold-ms",
    String(input.holdMilliseconds ?? 15_000),
  ];
  if (input.accessibilityConfigPath) {
    args.push("--config", input.accessibilityConfigPath);
  }
  return runHelper<JianyingUiaProbe>(args);
}

export function readJianyingUiaTree(maxElements = 500) {
  return runHelper<JianyingUiaProbe>(["tree", "--max-elements", String(maxElements)]);
}

type JianyingElementSelector = {
  name?: string;
  automationId?: string;
  className?: string;
  controlType?: string;
};

function appendSelector(args: string[], input: JianyingElementSelector) {
  if (input.name) args.push("--name", input.name);
  if (input.automationId) args.push("--automation-id", input.automationId);
  if (input.className) args.push("--class-name", input.className);
  if (input.controlType) args.push("--control-type", input.controlType);
}

export function invokeJianyingElement(input: JianyingElementSelector) {
  const args = ["invoke"];
  appendSelector(args, input);
  return runHelper<{ success: boolean; message: string; element?: JianyingUiaElement }>(args);
}

export function clickJianyingElement(input: JianyingElementSelector) {
  const args = ["click"];
  appendSelector(args, input);
  return runHelper<{ success: boolean; message: string; element?: JianyingUiaElement }>(args);
}

export function doubleClickJianyingElement(input: JianyingElementSelector) {
  const args = ["double-click"];
  appendSelector(args, input);
  return runHelper<{ success: boolean; message: string; element?: JianyingUiaElement }>(args);
}

export function setJianyingElementValue(input: {
  value: string;
} & JianyingElementSelector) {
  const args = ["set-value", "--value", input.value];
  appendSelector(args, input);
  return runHelper<{ success: boolean; message: string; element?: JianyingUiaElement }>(args);
}

export function typeJianyingElementText(input: {
  value: string;
} & JianyingElementSelector) {
  const args = ["type-text", "--value", input.value];
  appendSelector(args, input);
  return runHelper<{ success: boolean; message: string; element?: JianyingUiaElement }>(args);
}

export function captureJianyingWindow(outputPath: string) {
  return runHelper<{
    success: boolean;
    message: string;
    path: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }>(["capture-window", "--output", path.resolve(outputPath)]);
}

export function clickJianyingPoint(x: number, y: number) {
  return runHelper<{ success: boolean; message: string; x: number; y: number }>([
    "click-point",
    "--x",
    String(Math.round(x)),
    "--y",
    String(Math.round(y)),
  ]);
}

export async function seekJianyingTimeline(timeMicroseconds: number, durationMicroseconds: number) {
  const args = [
    "seek-timeline",
    "--time-us",
    String(Math.round(timeMicroseconds)),
    "--duration-us",
    String(Math.round(durationMicroseconds)),
  ];
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runHelper<{
        success: boolean;
        message: string;
        timeUs: number;
        durationUs: number;
        x: number;
        y: number;
      }>(args);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes("时间轴") || attempt === 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw lastError;
}

export async function openFirstJianyingDraftResult(draftName: string) {
  try {
    return await runHelper<{
      success: boolean;
      message: string;
      draftName: string;
      x: number;
      y: number;
    }>(["open-first-draft", "--draft-name", draftName]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Unsupported command")) throw error;
    // Compatibility with a running app that still resolves the previous
    // one-shot helper binary. Search leaves exactly one visible draft card.
    return doubleClickJianyingElement({ className: "QQuickMouseArea" });
  }
}

function jianyingElementText(element: JianyingUiaElement) {
  return [element.name, element.value, element.helpText, element.legacyName]
    .filter(Boolean)
    .join(" ");
}

function hasMissingMediaDialog(tree: JianyingUiaProbe) {
  const text = tree.samples.map(jianyingElementText).join("\n");
  return text.includes("链接媒体")
    && (text.includes("媒体丢失") || text.includes("重新链接后再剪辑"));
}

export async function dismissJianyingMissingMediaDialog(detectionTimeoutMs = 2_500) {
  const detectionDeadline = Date.now() + detectionTimeoutMs;
  let tree: JianyingUiaProbe | undefined;
  while (Date.now() <= detectionDeadline) {
    // Do not wait for the limited UI tree sample to notice the auxiliary
    // window. The native helper scans every Jianying top-level window.
    const nativeResult = await runHelper<{ success: boolean; closedCount: number }>([
      "close-missing-media-window",
    ]).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Unsupported command")) {
        return { success: false, closedCount: 0 };
      }
      throw error;
    });
    if (nativeResult.closedCount > 0) return { dismissed: true };
    tree = await readJianyingUiaTree(5_000);
    if (hasMissingMediaDialog(tree)) break;
    if (Date.now() >= detectionDeadline) return { dismissed: false };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!tree) return { dismissed: false };

  const cancel = tree.samples.find((element) => (
    [element.name, element.value, element.helpText, element.legacyName]
      .some((value) => value.trim() === "取消")
  ));
  let closedByWindow = false;
  try {
    const result = await runHelper<{ success: boolean; closedCount: number }>([
      "close-missing-media-window",
    ]);
    closedByWindow = result.closedCount > 0;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Unsupported command")) throw error;
  }
  if (!closedByWindow) {
    if (!cancel) throw new Error("检测到链接媒体窗口，但未找到可关闭的窗口或取消按钮");
    await clickJianyingElement({ name: "取消" });
  }

  const closeDeadline = Date.now() + 5_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 200));
    tree = await readJianyingUiaTree(5_000);
    if (!hasMissingMediaDialog(tree)) return { dismissed: true };
  } while (Date.now() < closeDeadline);
  throw new Error("链接媒体弹窗未能关闭");
}

export async function waitForJianyingMediaVisible(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const tree = await readJianyingUiaTree(5_000);
    if (tree.samples.some((element) => (
      element.className.startsWith("MediaInfoView")
      || element.automationId.startsWith("material.library.item.")
    ))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}

export function pressJianyingSpace() {
  return runHelper<{ success: boolean; message: string }>(["press-space"]);
}

export function pressJianyingEnter() {
  return runHelper<{ success: boolean; message: string }>(["press-enter"]);
}

export function returnJianyingHome() {
  return runHelper<{ success: boolean; message: string }>(["return-home"]);
}

export function closeJianyingEditorWindow() {
  return runHelper<{ success: boolean; message: string; closed: boolean }>([
    "close-editor-window",
  ]);
}

export async function importJianyingMedia(files: string[]) {
  if (!files.length) throw new Error("没有可导入的分段视频");
  await runHelper<{ success: boolean; message: string; fileCount: number }>([
    "import-media",
    ...files.flatMap((file) => ["--file", path.resolve(file)]),
  ], 60_000);
  if (!(await waitForJianyingMediaVisible())) {
    throw new Error("视频片段已提交导入，但剪映素材区域未显示素材");
  }
  return {
    success: true,
    message: "分段视频已导入剪映素材库",
    fileCount: files.length,
  };
}

async function countFiles(directory: string, expression: RegExp) {
  if (!(await pathExists(directory))) return 0;
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && expression.test(entry.name)).length;
}

export async function inspectJianyingPreset(presetPath: string): Promise<JianyingPresetSummary> {
  const normalizedPath = path.resolve(presetPath);
  const draftContentPath = path.join(normalizedPath, "draft_content.json");
  const draftMetadataPath = path.join(normalizedPath, "draft_meta_info.json");
  const hasDraftContent = await pathExists(draftContentPath);
  const hasDraftMetadata = await pathExists(draftMetadataPath);

  const canParseJson = async (filePath: string, exists: boolean) => {
    if (!exists) return false;
    try {
      JSON.parse(await readFile(filePath, "utf8"));
      return true;
    } catch {
      return false;
    }
  };
  const draftContentReadable = await canParseJson(draftContentPath, hasDraftContent);
  const draftMetadataReadable = await canParseJson(draftMetadataPath, hasDraftMetadata);

  const timelineDirectory = path.join(normalizedPath, "Timelines");
  const timelineEntries = await pathExists(timelineDirectory)
    ? await readdir(timelineDirectory, { withFileTypes: true })
    : [];

  return {
    path: normalizedPath,
    name: path.basename(normalizedPath),
    valid: hasDraftContent && hasDraftMetadata,
    videoCount: await countFiles(path.join(normalizedPath, "video_segments"), /\.mp4$/i),
    audioCount: await countFiles(normalizedPath, /\.(?:wav|mp3)$/i),
    timelineCount: timelineEntries.filter((entry) => entry.isDirectory()).length,
    hasDraftContent,
    hasDraftMetadata,
    draftContentReadable,
    draftMetadataReadable,
  };
}

export async function installJianyingPreset(input: {
  presetPath: string;
  draftRoot: string;
  draftName: string;
}) {
  const preset = await inspectJianyingPreset(input.presetPath);
  if (!preset.valid) throw new Error("不是有效的剪映草稿预设");

  const requestedName = input.draftName.trim();
  if (!requestedName) throw new Error("草稿名称不能为空");
  const safeName = safeFileName(requestedName, { fallback: "剪映草稿", replacement: "-" });
  const draftRoot = path.resolve(input.draftRoot);
  const targetPath = path.join(draftRoot, safeName);
  if (path.dirname(targetPath) !== draftRoot) throw new Error("草稿目标路径无效");
  if (await pathExists(targetPath)) throw new Error(`草稿已存在：${safeName}`);

  await cp(preset.path, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  return inspectJianyingPreset(targetPath);
}
