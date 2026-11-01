// Read-only inspection: no network API calls to Baidu, task submission, login,
// navigation, cookie reads, or upload/download queue changes.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/baidu-netdisk-automation/package.json', import.meta.url));
const WebSocket = require('ws');
const base = new URL(process.argv[2] || 'http://127.0.0.1:9337');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
  throw new Error('Only a local HTTP CDP endpoint is supported');
}
const get = async pathname => {
  const response = await fetch(new URL(pathname, base), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`CDP ${pathname}: HTTP ${response.status}`);
  return response.json();
};
const version = await get('/json/version');
const targets = await get('/json/list');
const safeUrl = value => {
  try {
    const url = new URL(value);
    const pathname = url.hostname === 'pan.baidu.com' && url.pathname.startsWith('/s/') ? '/s/[redacted]' : url.pathname;
    return `${url.protocol}//${url.host}${pathname}`;
  }
  catch { return 'unavailable'; }
};
const core = targets.find(target => target.webSocketDebuggerUrl && target.url?.includes('core.asar')
  && !/#\/(?:bubble_menu|sestonMenu|workspace)/.test(target.url));
const report = {
  capturedAt: new Date().toISOString(),
  version: { browser: version.Browser, protocol: version['Protocol-Version'], userAgent: version['User-Agent'] },
  targets: targets.map(({ id, type, url }) => ({ id, type, url: safeUrl(url) })),
  methods: null,
};
if (core) {
  const socket = new WebSocket(core.webSocketDebuggerUrl);
  try {
    report.methods = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP method inspection timed out')), 5_000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('open', () => socket.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
          try {
            const app = require('@electron/remote').app;
            const inspect = (object, names) => Object.fromEntries(names.map(name => [name, typeof object?.[name] === 'function']));
            return {
              historyRecord: typeof app.$getHistoryRecord === 'function',
              downloader: inspect(app.$downloader, ['addDownloadTask', 'getDownloadTasks', 'getDownloadHistory', 'getDownloadTaskCount', 'pauseTask', 'enqueueTask', 'deleteTask', 'deleteCompletedTask']),
              uploader: inspect(app.$uploader, ['addFiles', 'getUploadTasks', 'getUploadHistory', 'pauseTask', 'enqueueTask', 'deleteTask']),
            };
          } catch (error) { return { error: String(error?.message || error) }; }
        })()` },
      })));
      socket.on('message', data => {
        const message = JSON.parse(String(data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error('CDP read-only probe failed'));
        else resolve(message.result?.result?.value ?? null);
      });
    });
  } finally { socket.close(); }
}
console.log(JSON.stringify(report, null, 2));
