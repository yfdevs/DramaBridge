import { readdir } from "node:fs/promises";
import path from "node:path";
import { logMain } from "../main-logger";
import { app, dialog, shell } from "electron";
import { emitIpcEvent, trpcIpc as ipc } from "../ipc";
import { scanEpisodes, separateVideos } from "@dramabridge/video-separation";
let running = false;
let paused = false;
let release: (() => void) | undefined;
let activeId = '';

export function registerVideoSeparationHandlers() {
  ipc.handle('video-separation:pause', (_event, value: boolean) => {
    paused = value;
    if (!value) { release?.(); release = undefined; }
    if (running) emitIpcEvent('video-separation:progress', {id: activeId, message: value ? '正在暂停（等待当前步骤完成）' : '继续处理中…'});
  });
  ipc.handle('video-separation:browse', async (_event, directory?: string) => {
    const current = path.resolve(directory || app.getPath('downloads'));
    const entries = await readdir(current, {withFileTypes:true});
    return {directory:current, parent:path.dirname(current), entries:entries.filter(e => e.isDirectory() || (e.isFile() && /\.(mp4|mov|mkv|m4v)$/i.test(e.name))).map(e => ({name:e.name,directory:e.isDirectory(),path:path.join(current,e.name)})).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name, 'zh-CN',{numeric:true}))};
  });
  ipc.handle('video-separation:choose' , async () => {
    const result = await dialog.showOpenDialog({properties:['openDirectory']});
    return result.canceled ? null : result.filePaths[0];
  });
  ipc.handle('video-separation:scan', async (_event, directory: string) => ({directory, count:(await scanEpisodes(directory)).length}));
  ipc.handle('video-separation:run', async (_event, directory: string, seconds: number, taskId: string) => {
    if (running) throw new Error('已有视频任务正在处理');
    running = true; paused = false; activeId = taskId;
    try { return await separateVideos(directory, seconds, async message => {
      if (paused) {
        emitIpcEvent('video-separation:progress', {id: taskId, message: '已暂停'});
        await new Promise<void>(resolve => { release = resolve; });
      }
      emitIpcEvent('video-separation:progress', {id: taskId, message});
    }, (message, details) => {
      console.log('[video-separation]', message, details ?? '');
      logMain('info', message, {taskId, ...details}, 'video-separation');
    }); } catch (error) {
      logMain('error', '视频分离任务失败', {taskId,directory,error:String(error)}, 'video-separation');
      throw error;
    } finally { running = false; paused = false; release?.(); release = undefined; }

  });
  ipc.handle('video-separation:open', async (_event, directory: string) => { await shell.openPath(directory); });
}
