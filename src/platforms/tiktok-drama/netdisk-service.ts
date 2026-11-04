import type { NetdiskDramaList, NetdiskDramaQuery } from './netdisk-types';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.ipcRenderer) throw new Error('转存网盘仅在桌面应用内可用');
  return window.ipcRenderer.invoke('tiktok-drama:netdisk:' + channel, ...args) as Promise<T>;
}
export const tiktokNetdiskService = {
  list: (query: NetdiskDramaQuery) => invoke<NetdiskDramaList>('list', query),
  import: () => invoke<{ count: number; importedAt: string; errors: string[] } | null>('import'),
  export: (query: Pick<NetdiskDramaQuery, 'from' | 'to'>) => invoke<{ count: number } | null>('export', query),
  start: (query: NetdiskDramaQuery) => invoke<{ accepted: number }>('start', query),
  retry: (id: number) => invoke<{ accepted: number }>('retry', id),
  delete: (id: number) => invoke<{ deleted: boolean }>('delete', id),
  stop: () => invoke<{ running: boolean }>('stop'),
};
