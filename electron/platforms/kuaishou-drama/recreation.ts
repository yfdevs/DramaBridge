import { dialog } from "electron";
import { stat } from "node:fs/promises";
import { emitIpcEvent, trpcIpc as ipcMain } from "../../ipc";
import { openAutomationDatabase } from "../../storage/database";
import { KuaishouRecreationRepository } from "../../storage/kuaishou-recreation";
import { executeRecreationTask } from "./recreation-workflow";
import { createRecreationTemplate, readRecreationExcel } from "./recreation-excel";
import {
  ensureBaiduNetdiskShareDownloaded,
  findKuaishouRecreationDownloadedSource,
  kuaishouRecreationMaterialRoot,
  uploadKuaishouRecreationVersion,
} from "../baidu-netdisk";
import type {
  RecreationTask,
  RecreationWorkspace,
} from "../../../src/platforms/kuaishou-drama/recreation-types";
import { openExistingPath, playwrightBrowsersPath } from "../shared";

export function registerKuaishouRecreationHandlers() {
  // Lazy initialization avoids creating a second connection until the page is used.
  let repository: KuaishouRecreationRepository | undefined;
  const repo = () =>
    (repository ??= new KuaishouRecreationRepository(openAutomationDatabase().database));
  let running = false;
  let activeId: string | undefined;
  let controller: AbortController | undefined;
  let notification: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (notification) return;
    notification = setTimeout(() => {
      notification = undefined;
      emitIpcEvent("kuaishou-drama:recreation:changed");
    }, 100);
  };
  const pendingProgress = new Map<string, ReturnType<typeof setTimeout>>();
  const workspace = (): RecreationWorkspace => ({ running, tasks: repo().list().map(task => ({
    ...task,
    results: task.results.map(version => {
      const summary = { ...version };
      delete summary.localFiles; // File checkpoints belong to the runtime, not renderer IPC payloads.
      delete summary.verifiedFiles;
      return summary;
    }),
  })) });
  const update = (task: RecreationTask, fields: Partial<RecreationTask>) => {
    Object.assign(task, fields);
    if (Object.keys(fields).every(key => key === "message")) {
      if (!pendingProgress.has(task.id)) pendingProgress.set(task.id, setTimeout(() => {
        pendingProgress.delete(task.id);
        repo().save(task);
        notify();
      }, 500));
      return;
    }
    clearTimeout(pendingProgress.get(task.id));
    pendingProgress.delete(task.id);
    repo().save(task);
    notify();
  };
  const execute = async (task: RecreationTask, signal: AbortSignal) => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
    const runtime = await import("@dramabridge/kuaishou-drama-automation");
    return executeRecreationTask(task, {
      materialRoot: kuaishouRecreationMaterialRoot(), runtime, signal,
      legacySourcePath: findKuaishouRecreationDownloadedSource(task),
      update: fields => update(task, fields),
      download: async targetRoot => {
        const downloaded = await ensureBaiduNetdiskShareDownloaded({
          requesterPlatform: "kuaishou-drama-recreation", shareText: task.shareText,
          resourceName: task.originalTitle, episodeCount: task.downloadCount,
          episodeDownloadLimit: task.downloadCount, requiredPosterImages: 1,
          localEpisodeVideoRoot: targetRoot, downloadEpisodeVideos: true,
          downloadAssetMaterials: true, mergeOwnershipMaterials: false,
          requireAllDiscoveredAssets: false, signal,
        });
        if (downloaded.state !== "completed" || !downloaded.localPath) throw new Error("素材下载未完成");
        return downloaded.localPath;
      },
      upload: (localDirectory, title, onProgress, preferredRemoteDirectory, onRemoteDirectorySelected, verification) => uploadKuaishouRecreationVersion({
        localDirectory, remoteDirectory: `/快手_二创集合/${task.originalTitle}/${title}-60%`, signal, onProgress,
        preferredRemoteDirectory, onRemoteDirectorySelected,
        ...verification,
      }),
    });
  };
  const pump = async () => {
    try {
      while (running) {
        const task = repo().nextQueued();
        if (!task) break;
        activeId = task.id;
        controller = new AbortController();
        try {
          await execute(task, controller.signal);
        } catch (error) {
          update(task, {
            state: controller.signal.aborted ? "interrupted" : "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          activeId = undefined;
          controller = undefined;
        }
      }
    } finally {
      running = false;
      notify();
    }
  };
  ipcMain.handle("kuaishou-drama:recreation:workspace", workspace);
  ipcMain.handle("kuaishou-drama:recreation:template", async () => {
    const result = await dialog.showSaveDialog({
      title: "下载二创导入模板",
      defaultPath: "快手二创导入模板.xlsx",
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await createRecreationTemplate(result.filePath);
    return true;
  });
  ipcMain.handle("kuaishou-drama:recreation:import", async () => {
    const result = await dialog.showOpenDialog({
      title: "导入二创任务",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (result.canceled) return { count: 0, workspace: workspace() };
    if ((await stat(result.filePaths[0])).size > 20 * 1024 * 1024)
      throw new Error("Excel 文件不能超过 20 MB");
    const inputs = await readRecreationExcel(result.filePaths[0]);
    repo().import(inputs);
    notify();
    return { count: inputs.length, workspace: workspace() };
  });
  ipcMain.handle("kuaishou-drama:recreation:start", () => {
    if (!running && !activeId) {
      running = true;
      notify();
      void pump();
    }
    return workspace();
  });
  ipcMain.handle("kuaishou-drama:recreation:pause", () => {
    running = false;
    notify();
    return workspace();
  });
  ipcMain.handle("kuaishou-drama:recreation:cancel", () => {
    running = false;
    controller?.abort(new Error("用户停止任务，已完成的版本分享链接会保留"));
    notify();
    return workspace();
  });
  ipcMain.handle("kuaishou-drama:recreation:retry", (_event, id: string) => {
    const task = repo()
      .list()
      .find((task) => task.id === id);
    if (!task || !["failed", "interrupted"].includes(task.state))
      throw new Error("仅失败或中断任务可以重试");
    update(task, { state: "queued", message: "等待重试，保留已完成版本" });
    return workspace();
  });
  ipcMain.handle("kuaishou-drama:recreation:delete", (_event, id: string) => {
    if (activeId === id) throw new Error("请先停止当前任务再删除");
    repo().delete(id);
    notify();
    return workspace();
  });
  ipcMain.handle("kuaishou-drama:recreation:open", async (_event, id: string) => {
    const task = repo()
      .list()
      .find((task) => task.id === id);
    if (!task?.localPath) throw new Error("尚未生成本地版本目录");
    return openExistingPath(task.localPath);
  });
}
