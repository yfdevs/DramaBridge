import { promisify } from "node:util";
import { randomInt } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, copyFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { app, ipcMain } from "electron";
import Store from "electron-store";
import {
  captureJianyingWindow,
  closeJianyingEditorWindow,
  dismissJianyingMissingMediaDialog,
  findDramaEpisodes,
  inspectJianyingPreset,
  importJianyingMedia,
  installJianyingPreset,
  launchJianyingWithUia,
  markPreparedEpisodeMediaLibraryWritten,
  markPreparedEpisodeTrackWritten,
  openFirstJianyingDraftResult,
  prepareEpisodeDraft,
  probeJianyingUia,
  readJianyingUiaTree,
  readPreparedEpisodeDraft,
  seekJianyingTimeline,
  setJianyingElementValue,
  writeJianyingDraftVideoTrack,
  type JianyingUiaProbe,
} from "@drama/jianying-automation";

import { selectDirectory } from "./shared";
import { getConfiguredJianyingEpisodeCount } from "../global-app-config";
import {
  ownershipScreenshotPath,
  presetNameForEpisode,
  sortNumberedPresetNames,
} from "./jianying/collection-plan";

type JianyingConfig = {
  executablePath: string;
};

type JianyingAutomationSession = {
  executablePath: string;
  startedAt: string;
};

type JianyingStore = {
  config: JianyingConfig;
  automationSession: JianyingAutomationSession | null;
};

export type JianyingStatus = {
  platform: "jianying";
  isWindows: boolean;
  appRunning: boolean;
  installed: boolean;
  pathValid: boolean;
  accessibilityPrepared: boolean;
  uiaControlCount: number;
  configuredPath: string;
  executablePath?: string;
  checkedAt: string;
  message: string;
};

const execFile = promisify(execFileCallback);
const defaultConfig: JianyingConfig = { executablePath: "" };
let store: Store<JianyingStore> | null = null;
let accessibilityLockGeneration = 0;
let lastUiaProbe: JianyingUiaProbe | null = null;
const presetSubtitleGapCache = new Map<string, Array<[number, number]>>();

function getStore() {
  if (!store) {
    store = new Store<JianyingStore>({
      name: "jianying-config",
      defaults: { config: defaultConfig, automationSession: null },
    });
  }

  return store;
}

function readConfig(): JianyingConfig {
  return {
    executablePath: getStore().get("config").executablePath?.trim() ?? "",
  };
}

function writeConfig(config: JianyingConfig) {
  getStore().set("config", config);
}

function readAutomationSession() {
  return getStore().get("automationSession");
}

function writeAutomationSession(session: JianyingAutomationSession | null) {
  getStore().set("automationSession", session);
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutableCandidate(candidate: string): Promise<string | null> {
  const normalized = candidate.trim().replace(/^"|"$/g, "");
  if (!normalized) return null;

  try {
    const candidateStat = await stat(normalized);
    if (candidateStat.isFile()) {
      if (path.basename(normalized).toLowerCase() !== "jianyingpro.exe") return null;
      const executableDirectory = path.dirname(normalized);
      if (await pathExists(path.join(executableDirectory, "videoeditor.dll"))) return normalized;
      const versionedExecutable = await resolveVersionedExecutable(executableDirectory);
      return versionedExecutable ?? normalized;
    }

    if (!candidateStat.isDirectory()) return null;
  } catch {
    return null;
  }

  const directExecutable = path.join(normalized, "JianyingPro.exe");
  if (
    await pathExists(directExecutable)
    && await pathExists(path.join(normalized, "videoeditor.dll"))
  ) return directExecutable;

  const versionedExecutable = await resolveVersionedExecutable(normalized);
  if (versionedExecutable) return versionedExecutable;
  if (await pathExists(directExecutable)) return directExecutable;

  return null;
}

async function resolveVersionedExecutable(appsDirectory: string) {
  try {
    const children = await readdir(appsDirectory, { withFileTypes: true });
    const versionDirectories = children
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

    for (const directory of versionDirectories) {
      const versionDirectory = path.join(appsDirectory, directory);
      const executablePath = path.join(versionDirectory, "JianyingPro.exe");
      if (
        await pathExists(executablePath)
        && await pathExists(path.join(versionDirectory, "videoeditor.dll"))
      ) return executablePath;
    }
  } catch {
    return null;
  }
  return null;
}

function defaultAppsDirectory() {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  return localAppData ? path.join(localAppData, "JianyingPro", "Apps") : "";
}

async function resolveJianyingExecutable(config = readConfig()) {
  if (config.executablePath) {
    return resolveExecutableCandidate(config.executablePath);
  }

  const appsDirectory = defaultAppsDirectory();
  return appsDirectory ? resolveExecutableCandidate(appsDirectory) : null;
}

async function isJianyingRunning() {
  if (process.platform !== "win32") return false;

  try {
    const { stdout } = await execFile("tasklist.exe", [
      "/FI",
      "IMAGENAME eq JianyingPro.exe",
      "/FO",
      "CSV",
      "/NH",
    ], { windowsHide: true });
    return stdout.toLowerCase().includes("jianyingpro.exe");
  } catch {
    return false;
  }
}

function userDataDirectoryFromExecutable(executablePath: string) {
  let appsDirectory = path.dirname(executablePath);
  while (
    path.basename(appsDirectory).toLowerCase() !== "apps"
    && path.dirname(appsDirectory) !== appsDirectory
  ) {
    appsDirectory = path.dirname(appsDirectory);
  }
  const jianyingRoot = path.basename(appsDirectory).toLowerCase() === "apps"
    ? path.dirname(appsDirectory)
    : path.dirname(path.dirname(executablePath));
  return path.join(jianyingRoot, "User Data");
}

function replaceIniSetting(content: string, key: string, value: string) {
  const expression = new RegExp(`^${key}=.*$`, "m");
  if (expression.test(content)) return content.replace(expression, `${key}=${value}`);

  const generalHeader = /^\[General\]\s*$/m;
  if (generalHeader.test(content)) {
    return content.replace(generalHeader, `[General]\n${key}=${value}`);
  }

  return `[General]\n${key}=${value}\n${content}`;
}

async function setReadOnly(filePath: string, readOnly: boolean) {
  await execFile("attrib.exe", [readOnly ? "+R" : "-R", filePath], { windowsHide: true });
}

async function prepareAccessibilityConfig(executablePath: string) {
  const configPath = path.join(userDataDirectoryFromExecutable(executablePath), "Config", "globalSetting");
  if (!(await pathExists(configPath))) return null;

  const backupPath = `${configPath}.autodrama-backup`;
  if (!(await pathExists(backupPath))) {
    await copyFile(configPath, backupPath);
  }

  await setReadOnly(configPath, false).catch(() => undefined);
  let content = await readFile(configPath, "utf8");
  content = replaceIniSetting(content, "disable_qt_access", "0");
  content = replaceIniSetting(content, "accessibleDisableUnignoredChildren", "0");
  content = replaceIniSetting(content, "disable_qt_access_event", "false");
  await writeFile(configPath, content, "utf8");
  await setReadOnly(configPath, true);
  return configPath;
}

async function stopJianyingProcesses() {
  for (const processName of ["JianyingPro.exe", "JianyingProTray.exe"]) {
    await execFile("taskkill.exe", ["/IM", processName, "/T", "/F"], { windowsHide: true })
      .catch(() => undefined);
  }
}

async function waitForJianyingStart(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isJianyingRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForJianyingStop(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isJianyingRunning())) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function waitForJianyingOperable(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await probeJianyingUia();
      if (probe.operable) return probe;
    } catch {
      // Jianying can briefly reject UI Automation probes while its window initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("剪映界面启动超时");
}

async function releaseAccessibilitySessionWhenStopped(filePath: string | null, generation: number) {
  let consecutiveStoppedChecks = 0;
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  while (generation === accessibilityLockGeneration && consecutiveStoppedChecks < 5) {
    consecutiveStoppedChecks = await isJianyingRunning()
      ? 0
      : consecutiveStoppedChecks + 1;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  if (generation === accessibilityLockGeneration) {
    writeAutomationSession(null);
    if (filePath) await setReadOnly(filePath, false).catch(() => undefined);
  }
}

export async function getJianyingStatus(): Promise<JianyingStatus> {
  const config = readConfig();
  const executablePath = await resolveJianyingExecutable(config);
  const appRunning = await isJianyingRunning();
  if (!appRunning && readAutomationSession()) {
    writeAutomationSession(null);
  }
  const installed = Boolean(executablePath);
  const pathValid = !config.executablePath || installed;
  if (appRunning) {
    try {
      lastUiaProbe = await probeJianyingUia();
    } catch {
      lastUiaProbe = null;
    }
  } else {
    lastUiaProbe = null;
  }
  const accessibilityPrepared = Boolean(appRunning && lastUiaProbe?.operable);

  let message = "剪映未安装或未找到可执行文件。";
  if (config.executablePath && !pathValid) message = "配置的剪映路径无效，请重新填写。";
  else if (appRunning && accessibilityPrepared) message = "剪映正在运行，UI Automation 已启用。";
  else if (appRunning && lastUiaProbe?.available) message = "已找到剪映窗口，但未读取到可操作控件。";
  else if (appRunning) message = "剪映正在运行，但 UI Automation 不可用。";
  else if (installed) message = "剪映已就绪，可以启动 UI Automation 模式。";

  return {
    platform: "jianying",
    isWindows: process.platform === "win32",
    appRunning,
    installed,
    pathValid,
    accessibilityPrepared,
    uiaControlCount: lastUiaProbe?.controlCount ?? 0,
    configuredPath: config.executablePath,
    executablePath: executablePath ?? undefined,
    checkedAt: new Date().toISOString(),
    message,
  };
}

async function launchJianying(restart: boolean) {
  if (process.platform !== "win32") {
    throw new Error("剪映 UI Automation 目前仅支持 Windows。");
  }

  const executablePath = await resolveJianyingExecutable();
  if (!executablePath) {
    throw new Error("没有找到剪映专业版，请重新填写 JianyingPro.exe 或安装目录。");
  }

  let lockGeneration: number;
  if (restart) {
    lockGeneration = ++accessibilityLockGeneration;
    writeAutomationSession(null);
    await stopJianyingProcesses();
  } else {
    if (await isJianyingRunning()) return getJianyingStatus();
    lockGeneration = ++accessibilityLockGeneration;
  }

  const lockedConfigPath = await prepareAccessibilityConfig(executablePath);
  let started = false;
  try {
    lastUiaProbe = await launchJianyingWithUia({
      executablePath,
      accessibilityConfigPath: lockedConfigPath,
      holdMilliseconds: 3_000,
    });
    started = await waitForJianyingStart();
    if (!started) throw new Error("剪映启动超时，请检查安装路径或客户端状态。");
    lastUiaProbe = await waitForJianyingOperable();
    writeAutomationSession({
      executablePath,
      startedAt: new Date().toISOString(),
    });
  } finally {
    if (lockedConfigPath && !started) {
      await setReadOnly(lockedConfigPath, false).catch(() => undefined);
    }
  }

  void releaseAccessibilitySessionWhenStopped(lockedConfigPath, lockGeneration);

  return getJianyingStatus();
}

function presetSourcePath(presetName: string) {
  const presetsRoot = presetsRootPath();
  const sourcePath = path.resolve(presetsRoot, presetName);
  if (path.dirname(sourcePath) !== path.resolve(presetsRoot)) {
    throw new Error("预设路径无效");
  }
  return sourcePath;
}

function presetsRootPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "presets")
    : path.join(app.getAppPath(), "assets", "presets");
}

async function numberedPresetNames() {
  const entries = await readdir(presetsRootPath(), { withFileTypes: true }).catch(() => []);
  const presets = sortNumberedPresetNames(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  if (!presets.length) throw new Error("没有找到可用的剪映预设");
  return presets;
}

async function openJianyingPreset(presetName: string) {
  const executablePath = await resolveJianyingExecutable();
  if (!executablePath) throw new Error("没有找到剪映专业版");

  const draftName = `AutoDrama-${presetName}`;
  const draftRoot = path.join(userDataDirectoryFromExecutable(executablePath), "Projects", "com.lveditor.draft");
  const installedPath = path.join(draftRoot, draftName);
  const preset = await (await pathExists(installedPath)
    ? inspectJianyingPreset(installedPath)
    : installJianyingPreset({
        presetPath: presetSourcePath(presetName),
        draftRoot,
        draftName,
      }));

  const probe = await openJianyingDraft(draftName);

  return { preset, probe, status: await getJianyingStatus() };
}

async function openJianyingDraft(draftName: string) {
  await launchJianying(false);
  const currentProbe = await readJianyingUiaTree(2_000);
  const editorIsOpen = currentProbe.windows.some(
    (window) => window.automationId === "MainWindow",
  );
  if (editorIsOpen) {
    await dismissJianyingMissingMediaDialog(300).catch(() => undefined);
    await closeJianyingEditorWindow();
    const homeProbe = await waitForJianyingProbe(
      (nextProbe) => nextProbe.windows.some((window) => window.automationId === "HomeWindow"),
      5_000,
    );
    if (!homeProbe.windows.some((window) => window.automationId === "HomeWindow")) {
      // Closing the editor normally reveals Jianying's already-running home
      // window. Restart only as a recovery path when that handoff fails.
      await launchJianying(true);
    }
  }
  let searchProbe = await searchJianyingDraft(draftName);
  if (!searchProbe.samples.some((element) => element.className === "QQuickMouseArea")) {
    // Jianying only indexes draft directories during startup. Refresh once
    // after generating a new collection, then reuse the process for all
    // remaining episodes.
    await launchJianying(true);
    searchProbe = await searchJianyingDraft(draftName);
  }
  if (!searchProbe.samples.some((element) => element.className === "QQuickMouseArea")) {
    throw new Error(`剪映未在本地草稿中找到：${draftName}`);
  }
  await openFirstJianyingDraftResult(draftName);
  const editorIsReady = (nextProbe: JianyingUiaProbe) => nextProbe.windows.some(
    (window) => window.automationId === "MainWindow",
  );
  let probe = await waitForJianyingProbe(editorIsReady, 15_000);
  if (!editorIsReady(probe)) {
    // A cold Jianying start can ignore the first synthetic double-click while
    // its draft card is still settling. Retry the selected search result once.
    searchProbe = await searchJianyingDraft(draftName);
    if (searchProbe.samples.some((element) => element.className === "QQuickMouseArea")) {
      await openFirstJianyingDraftResult(draftName);
      probe = await waitForJianyingProbe(editorIsReady, 20_000);
    }
  }
  if (!editorIsReady(probe)) {
    throw new Error(`剪映在 35 秒内未进入编辑器：${draftName}`);
  }
  await dismissJianyingMissingMediaDialog();
  return probe;
}

async function searchJianyingDraft(draftName: string) {
  // Jianying truncates long search values. The final 16 characters preserve
  // both the drama-name tail and the complete 第N集 suffix.
  const searchQuery = draftName.length > 16 ? draftName.slice(-16) : draftName;
  await setJianyingElementValue({
    controlType: "Edit",
    value: searchQuery,
  });
  // Let the QML result grid discard cards from the previous search before
  // selecting the first result.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return waitForJianyingProbe(
    (probe) => probe.samples.some((element) => element.className === "QQuickMouseArea"),
    1_500,
  );
}

async function waitForJianyingProbe(
  predicate: (probe: JianyingUiaProbe) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let probe = await probeJianyingUia();
  while (!predicate(probe) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    probe = await probeJianyingUia();
  }
  return probe;
}

async function prepareDramaCollection(dramaDirectory: string) {
  const normalizedDirectory = path.resolve(dramaDirectory.trim());
  const directoryStat = await stat(normalizedDirectory).catch(() => null);
  if (!directoryStat?.isDirectory()) throw new Error("剧目目录不存在");

  const executablePath = await resolveJianyingExecutable();
  if (!executablePath) throw new Error("没有找到剪映专业版");
  const draftRoot = path.join(
    userDataDirectoryFromExecutable(executablePath),
    "Projects",
    "com.lveditor.draft",
  );
  const episodeCount = getConfiguredJianyingEpisodeCount();
  const episodes = await findDramaEpisodes(normalizedDirectory, episodeCount);
  const presetNames = await numberedPresetNames();
  const prepared = [];
  const installDirectory = path.dirname(executablePath);
  const randomTimelineTime = (ranges: Array<[number, number]>) => {
    const validRanges = ranges.filter(([start, end]) => end > start);
    const totalDuration = validRanges.reduce((total, [start, end]) => total + end - start, 0);
    if (!totalDuration) throw new Error("第4轨道没有可用空白区间");
    let offset = randomInt(totalDuration);
    for (const [start, end] of validRanges) {
      const duration = end - start;
      if (offset < duration) return start + offset;
      offset -= duration;
    }
    return validRanges[validRanges.length - 1]![1] - 1;
  };
  const finalizeTrack = async (
    draft: {
      draftPath: string;
      draftName: string;
      segmentFiles: string[];
    },
    trackResult: Awaited<ReturnType<typeof writeJianyingDraftVideoTrack>>,
    sourcePresetPath: string,
  ) => {
    if (trackResult.subtitleFreeTimelineTime === null || !trackResult.subtitleFreeRanges.length) {
      throw new Error(`${draft.draftName} 的字幕轨道没有可用空白区间`);
    }
    // Each episode uses one immutable numbered preset. Cache that preset's
    // gaps once, then only choose a fresh random frame on later runs.
    let presetSubtitleFreeRanges = presetSubtitleGapCache.get(sourcePresetPath);
    if (!presetSubtitleFreeRanges) {
      presetSubtitleFreeRanges = trackResult.subtitleFreeRanges.map(
        ([start, end]) => [start, end] as [number, number],
      );
      presetSubtitleGapCache.set(sourcePresetPath, presetSubtitleFreeRanges);
    }
    const rangesForDuration = presetSubtitleFreeRanges
      .map(([start, end]) => [start, Math.min(end, trackResult.duration)] as [number, number])
      .filter(([start, end]) => end > start);
    const markedDraft = await markPreparedEpisodeTrackWritten(
      draft.draftPath,
      randomTimelineTime(rangesForDuration),
      trackResult.duration,
    );
    if (!trackResult.mediaLibraryWritten) {
      throw new Error(`${draft.draftName} 的素材索引写入失败`);
    }
    return markPreparedEpisodeMediaLibraryWritten(markedDraft.draftPath);
  };

  for (const episode of episodes) {
    const presetName = presetNameForEpisode(presetNames, episode.episode);
    const episodePresetPath = presetSourcePath(presetName);
    if (!(await pathExists(episodePresetPath))) {
      throw new Error(`缺少第${episode.episode}集预设：${presetName}`);
    }
    const draftName = `${path.basename(normalizedDirectory)}-第${episode.episode}集`;
    const draftPath = path.join(draftRoot, draftName);
    if (await pathExists(draftPath)) {
      const existing = await inspectJianyingPreset(draftPath);
      if (!existing.valid) {
        throw new Error(`已有草稿不完整，请先处理：${draftName}`);
      }
      const existingDraft = await readPreparedEpisodeDraft(draftPath).catch(() => {
        throw new Error(`已有同名草稿，无法确认是否由本应用创建：${draftName}`);
      });
      if (
        existingDraft.presetName !== presetName
        || path.resolve(existingDraft.presetPath ?? "") !== episodePresetPath
      ) {
        // Workflow v1/v2 used 新预设1 for every episode. These are known
        // app-generated temporary drafts, so migrate them automatically.
        if (await isJianyingRunning()) {
          await stopJianyingProcesses();
          if (!(await waitForJianyingStop())) {
            throw new Error("剪映未能完全退出，请关闭剪映后重试");
          }
        }
        await rm(draftPath, { recursive: true, force: true });
      } else if (
        !existingDraft.trackWrittenAt
        || !existingDraft.draftIdentitySynchronizedAt
        || !existingDraft.missingMediaCleanedAt
        || existingDraft.previewTimelineTime === undefined
        || !existingDraft.timelineDuration
        || !existingDraft.mediaLibraryWrittenAt
      ) {
        if (await isJianyingRunning()) {
          await stopJianyingProcesses();
          if (!(await waitForJianyingStop())) {
            throw new Error("剪映未能完全退出，请关闭剪映后重试");
          }
        }
        const trackResult = await writeJianyingDraftVideoTrack({
          draftPath: existingDraft.draftPath,
          installDirectory,
          segmentFiles: existingDraft.segmentFiles,
          registerAsNewDraft: true,
        });
        prepared.push(await finalizeTrack(existingDraft, trackResult, episodePresetPath));
        continue;
      } else {
        prepared.push(existingDraft);
        continue;
      }
    }

    const createdDraft = await prepareEpisodeDraft({
      dramaDirectory: normalizedDirectory,
      episode,
      presetPath: episodePresetPath,
      draftRoot,
    });
    try {
      const trackResult = await writeJianyingDraftVideoTrack({
        draftPath: createdDraft.draftPath,
        installDirectory,
        segmentFiles: createdDraft.segmentFiles,
        registerAsNewDraft: true,
      });
      prepared.push(await finalizeTrack(createdDraft, trackResult, episodePresetPath));
    } catch (error) {
      await rm(createdDraft.draftPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  if (!prepared.length) throw new Error("没有可处理的剧集");
  const screenshots: string[] = [];
  let probe: JianyingUiaProbe | null = null;
  // Jianying indexes every newly generated draft during startup. Do this once
  // for the whole batch, then switch episodes by closing only the editor.
  await launchJianying(true);
  for (const draft of prepared) {
    probe = await openJianyingDraft(draft.draftName);
    await importJianyingMedia(draft.segmentFiles);
    if (draft.previewTimelineTime === undefined || !draft.timelineDuration) {
      throw new Error(`${draft.draftName} 缺少无字幕画面定位信息`);
    }
    await seekJianyingTimeline(draft.previewTimelineTime, draft.timelineDuration);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalScreenshot = ownershipScreenshotPath(
      normalizedDirectory,
      draft.dramaName,
      draft.episode,
    );
    await captureJianyingWindow(finalScreenshot);
    screenshots.push(finalScreenshot);
  }

  if (await isJianyingRunning()) {
    await stopJianyingProcesses();
    if (!(await waitForJianyingStop())) {
      throw new Error("剪映未能完全退出，无法清理临时草稿");
    }
  }
  for (const draft of prepared) {
    const normalizedDraftPath = path.resolve(draft.draftPath);
    if (
      path.dirname(normalizedDraftPath) !== path.resolve(draftRoot)
      || path.basename(normalizedDraftPath) !== draft.draftName
    ) {
      throw new Error(`草稿清理路径无效：${draft.draftName}`);
    }
    await rm(normalizedDraftPath, { recursive: true, force: true });
  }
  return {
    dramaDirectory: normalizedDirectory,
    episodes,
    prepared,
    screenshot: screenshots[0],
    screenshots,
    cleanedDraftCount: prepared.length,
    probe,
    status: await getJianyingStatus(),
  };
}

export function registerJianyingPlatformHandlers() {
  ipcMain.handle("jianying:service:status", () => getJianyingStatus());
  ipcMain.handle("jianying:service:start", () => launchJianying(false));
  ipcMain.handle("jianying:service:restart", () => launchJianying(true));
  ipcMain.handle("jianying:preset:open", (_event, presetName?: string) => {
    const normalizedName = presetName?.trim();
    if (!normalizedName) throw new Error("预设名称不能为空");
    return openJianyingPreset(normalizedName);
  });
  ipcMain.handle("jianying:collection:select-directory", async (event) => {
    return selectDirectory(event, {
      title: "选择剧目目录",
      properties: ["openDirectory"],
    });
  });
  ipcMain.handle("jianying:collection:prepare", (_event, dramaDirectory?: string) => {
    const normalizedDirectory = dramaDirectory?.trim();
    if (!normalizedDirectory) throw new Error("请选择剧目目录");
    return prepareDramaCollection(normalizedDirectory);
  });
  ipcMain.handle("jianying:config:get", () => ({ config: readConfig(), path: getStore().path }));
  ipcMain.handle("jianying:config:select-executable", async (event) => {
    const currentExecutable = await resolveJianyingExecutable();
    const selectedPath = await selectDirectory(event, {
      title: "选择剪映",
      defaultPath: currentExecutable ?? (defaultAppsDirectory() || undefined),
      properties: ["openFile"],
      filters: [{ name: "剪映专业版", extensions: ["exe"] }],
    });

    if (!selectedPath) return null;
    if (!(await resolveExecutableCandidate(selectedPath))) {
      throw new Error("请选择 JianyingPro.exe");
    }

    const config = { executablePath: selectedPath };
    writeConfig(config);
    return { config, path: getStore().path };
  });
  ipcMain.handle("jianying:config:save", async (_event, input?: Partial<JianyingConfig>) => {
    const config = {
      executablePath: input?.executablePath?.trim() ?? "",
    };
    writeConfig(config);
    return { config, path: getStore().path };
  });
}
