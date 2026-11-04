import type { NetdiskDramaRecord } from "../../../src/platforms/tiktok-drama/netdisk-types";
import { app, dialog } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { trpcIpc } from '../../ipc';
import { TiktokNetdiskRepository } from '../../storage/tiktok-netdisk';
import { readNetdiskDramaWorkbook } from './netdisk-import';
import { createNetdiskDramaExport } from './netdisk-export';
import { transferTiktokDramaNetdiskVideos } from '../baidu-netdisk';

export function registerTiktokNetdiskHandlers() {
  let repository: TiktokNetdiskRepository | undefined;
  const repo = () => repository ??= new TiktokNetdiskRepository();
  let running = false;
  let stopRequested = false;
  const querySchema = z.object({ search: z.string().max(200).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(['pending', 'running', 'succeeded', 'failed']).optional(),
    page: z.number().int().min(1).max(100000).optional() });
  trpcIpc.handle('tiktok-drama:netdisk:list', (_event, query: unknown) => ({
    ...repo().list(querySchema.parse(query ?? {})), running,
  }));
  trpcIpc.handle('tiktok-drama:netdisk:import', async () => {
    const selection = await dialog.showOpenDialog({ title: '导入转存剧单', properties: ['openFile'],
      filters: [{ name: 'Excel 剧单', extensions: ['xlsx'] }] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const file = selection.filePaths[0];
    const parsed = await readNetdiskDramaWorkbook(file);
    return { ...repo().import(parsed.records, path.basename(file), await readFile(file)), errors: parsed.errors };
  });
  trpcIpc.handle('tiktok-drama:netdisk:export', async (_event, input: unknown) => {
    const query = querySchema.pick({ from: true, to: true }).parse(input ?? {});
    // Export every status, including failed jobs, for the selected import dates.
    const { records } = repo().list(query, true);
    if (!records.length) throw new Error('所选导入时间内没有可导出的剧目');
    const selection = await dialog.showSaveDialog({ title: '按导入时间导出剧单（包含失败记录）',
      defaultPath: `转存剧单-${query.from || '全部'}-${query.to || '全部'}.xlsx`,
      filters: [{ name: 'Excel 剧单', extensions: ['xlsx'] }] });
    if (selection.canceled || !selection.filePath) return null;
    for (const record of records) {
      if (record.status !== 'succeeded' || record.generatedLink) continue;
      if (running) throw new Error('请等待当前转存结束后导出，已完成的旧记录需要补建分享链接');
      const result = await transferTiktokDramaNetdiskVideos(record);
      repo().setShareLink(record.id, result.shareUrl);
      record.generatedLink = result.shareUrl;
    }
    const workbook = await createNetdiskDramaExport(records, repo().template(records[0].batchId));
    await workbook.xlsx.writeFile(selection.filePath);
    return { count: records.length };
  });
  const startTasks = (tasks: NetdiskDramaRecord[]) => {
    if (running) throw new Error('转存任务正在执行，请等待完成或停止后再试');
    if (!tasks.length) throw new Error('当前筛选范围内没有待转存或失败的剧目');
    running = true; stopRequested = false;
    // A single queue shares the client's existing exclusive cloud-operation lane.
    void (async () => {
      for (const task of tasks) {
        if (stopRequested) break;
        repo().update(task.id, 'running');
        repo().setProgress(task.id, 0, '等待网盘');
        try {
          const result = await transferTiktokDramaNetdiskVideos({ ...task, onProgress: progress => repo().setProgress(task.id, progress.completed, progress.stage) });
          repo().setShareLink(task.id, result.shareUrl);
          repo().update(task.id, 'succeeded', '', result.path);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          repo().update(task.id, 'failed', message);
          if (/8001|8011|RISK|IDENTITY|登录|登陆|CDP|连接|提取码|验证/.test(message)) stopRequested = true;
        }
      }
    })().catch(error => console.error('[tiktok-drama] 转存队列异常', error))
      .finally(() => { running = false; });
    return { accepted: tasks.length };
  };
  trpcIpc.handle('tiktok-drama:netdisk:start', (_event, input: unknown) => {
    const query = querySchema.parse(input ?? {});
    return startTasks(repo().list(query, true).records.filter(task => task.status === 'pending' || task.status === 'failed'));
  });
  trpcIpc.handle('tiktok-drama:netdisk:retry', (_event, input: unknown) => {
    const id = z.number().int().positive().parse(input);
    const task = repo().get(id);
    if (!task || task.status !== 'failed') throw new Error('只能重试失败的剧目');
    return startTasks([task]);
  });
  trpcIpc.handle('tiktok-drama:netdisk:delete', (_event, input: unknown) => {
    const id = z.number().int().positive().parse(input);
    if (running) throw new Error('请先停止转存队列，待当前剧目完成后再删除');
    repo().delete(id);
    return { deleted: true };
  });
  trpcIpc.handle('tiktok-drama:netdisk:stop', () => { stopRequested = true; return { running }; });
  app.once('before-quit', () => { stopRequested = true; });
  app.once('will-quit', () => repository?.close());
}
