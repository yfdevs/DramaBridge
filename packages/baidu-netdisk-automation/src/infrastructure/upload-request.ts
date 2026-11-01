import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { CdpPage } from "./cdp.js";
import { baiduApiError, baiduUploadRequestGate, BAIDU_RISK_CONTROL_MARKER } from "./request-policy.js";

type ApiResult = {
  errno?: number;
  error_code?: number;
  errmsg?: string;
  error_msg?: string;
  [key: string]: unknown;
};

export type LocalUploadPart = {
  path: string; offset: number; length: number; size: number;
  modifiedAtMs: number; md5: string; boundary: string;
};

// Execute network I/O entirely in Baidu's main process. Remote stream event
// forwarding can lose `end`, and Baidu's client may emit request `close` before
// its response. Only response completion, response errors and our timer settle it.
const mainRequestSource = `
  const active = globalThis.__dramaBridgeUploads ||= new Map();
  return new Promise(resolve => {
    let req;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(request.key);
      resolve(JSON.stringify(error ? { ok: false, message: error.message || String(error) } : { ok: true, value }));
    };
    const stop = message => { finish(new Error(message)); req?.abort(); };
    const prepare = async () => {
      let body;
      if (request.filePart) {
        const part = request.filePart;
        const file = await fs.promises.open(part.path, 'r');
        try {
          const before = await file.stat();
          if (!before.isFile() || before.size !== part.size || Math.abs(before.mtimeMs - part.modifiedAtMs) > 1)
            throw new Error('素材文件在上传前发生变化');
          const buffer = Buffer.alloc(part.length);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, part.offset);
          const after = await file.stat();
          if (bytesRead !== part.length || after.size !== part.size || Math.abs(after.mtimeMs - part.modifiedAtMs) > 1
            || crypto.createHash('md5').update(buffer).digest('hex') !== part.md5)
            throw new Error('素材文件在分片读取中发生变化');
          body = Buffer.concat([
            Buffer.from('--' + part.boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="blob"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n'),
            buffer,
            Buffer.from('\\r\\n--' + part.boundary + '--\\r\\n'),
          ]);
        } finally { await file.close(); }
      } else if (request.body !== undefined) body = Buffer.from(request.body, 'base64');
      if (settled) return;
      const pages = electron.webContents.getAllWebContents().filter(contents => {
        try { return new URL(contents.getURL()).hostname === 'pan.baidu.com'; } catch { return false; }
      });
      const source = pages.find(contents => new URL(contents.getURL()).pathname.startsWith('/disk'))
        || pages[0] || electron.webContents.fromId(request.sourceId);
      if (!source || source.isDestroyed?.()) throw new Error('网盘登录页面不可用，请打开百度网盘并登录');
      req = electron.net.request({ url: request.url, method: request.method, session: source.session, useSessionCookies: true });
      req.on('error', error => finish(error));
      req.on('response', response => {
        const chunks = [];
        const hash = request.responseType === 'checksum' ? crypto.createHash('md5') : undefined;
        let received = 0;
        response.on('data', chunk => {
          if (settled) return;
          if (!hash) { chunks.push(chunk); return; }
          received += chunk.length;
          if (received > request.expectedSize) { stop('网盘回读文件长度超过预期'); return; }
          hash.update(chunk);
        });
        response.on('error', error => finish(error));
        response.on('aborted', () => finish(new Error('百度上传响应中断 net::ERR_CONNECTION_CLOSED')));
        response.on('end', () => {
          try {
            if (response.statusCode === 429) throw new Error('[BAIDU_NETDISK_RISK_CONTROL] 百度上传接口 HTTP 429，请在客户端确认账号状态，稍后手动重试');
            if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('百度上传接口 HTTP ' + response.statusCode);
            if (hash) {
              if (received !== request.expectedSize) throw new Error('网盘回读文件长度不完整');
              finish(null, { size: received, md5: hash.digest('hex') });
            } else finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) { finish(error); }
        });
      });
      req.setHeader('Referer', 'https://pan.baidu.com/disk/main');
      if (request.responseType === 'checksum') req.setHeader('User-Agent', 'pan.baidu.com');
      const contentType = request.filePart ? 'multipart/form-data; boundary=' + request.filePart.boundary : request.contentType;
      if (contentType) req.setHeader('Content-Type', contentType);
      if (body !== undefined) req.write(body);
      req.end();
    };
    timer = setTimeout(() => stop('百度上传接口请求超时'), request.timeoutMs);
    active.set(request.key, () => stop('上传已取消'));
    void prepare().catch(error => { finish(error); req?.abort(); });
  });
`;

/** Uses the logged-in client's session. Only reads and individual upload blocks may retry. */
export async function clientUploadRequest(
  page: Pick<CdpPage, "evaluate">,
  url: string,
  body?: Buffer,
  contentType?: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    retryable?: boolean;
    label?: string;
    onRetry?: (message: string) => void;
    responseType?: "json" | "checksum";
    expectedSize?: number;
    traffic?: "metadata" | "data";
    filePart?: LocalUploadPart;
  } = {},
): Promise<ApiResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const attempts = (options.retryable ?? (!body && !options.filePart)) ? 3 : 1;
  const endpoint = new URL(url);
  if (options.filePart) {
    const part = options.filePart;
    if (body || endpoint.protocol !== "https:" || endpoint.username || endpoint.password
      || !/(^|\.)(pcs\.baidu\.com|baidupcs\.com)$/.test(endpoint.hostname)
      || endpoint.pathname !== "/rest/2.0/pcs/superfile2" || endpoint.searchParams.get("method") !== "upload"
      || !path.isAbsolute(part.path) || !Number.isSafeInteger(part.offset) || part.offset < 0
      || !Number.isSafeInteger(part.size) || part.size <= 0 || !Number.isFinite(part.modifiedAtMs)
      || !Number.isSafeInteger(part.length) || part.length <= 0 || part.length > 4 * 1024 * 1024
      || part.offset + part.length > part.size || !/^[a-f0-9]{32}$/.test(part.md5)
      || !/^[a-zA-Z0-9_-]{1,70}$/.test(part.boundary)) throw new Error("无效的客户端本地上传分片");
  }
  if (options.responseType === "checksum" && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize! <= 0))
    throw new Error("网盘回读校验缺少有效文件长度");
  const label = options.label ?? `${endpoint.host}${endpoint.pathname}`;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    await baiduUploadRequestGate.acquire(options.signal, options.traffic);
    const key = randomUUID();
    let cancel: (() => void) | undefined;
    try {
      const pending = page.evaluate<ApiResult>(
        `(async () => {
          const remote = require('@electron/remote');
          const run = remote.require('vm').compileFunction(${JSON.stringify(mainRequestSource)}, ['electron', 'request', 'crypto', 'fs']);
          const result = JSON.parse(await run(remote.require('electron'), {
            ...${JSON.stringify({ key, url, method: body || options.filePart ? "POST" : "GET", body: body?.toString("base64"), filePart: options.filePart, contentType, timeoutMs, responseType: options.responseType, expectedSize: options.expectedSize })},
            sourceId: remote.getCurrentWebContents().id,
          }, remote.require('crypto'), remote.require('fs')));
          if (!result.ok) throw new Error(result.message);
          return result.value;
        })()`,
        timeoutMs + 5_000,
        label,
      );
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => {
          const stop = `globalThis.__dramaBridgeUploads?.get(${JSON.stringify(key)})?.()`;
          void page.evaluate(`require('@electron/remote').require('vm').runInThisContext(${JSON.stringify(stop)})`, 5_000).catch(() => undefined);
          reject(options.signal?.reason ?? new Error("上传已取消"));
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) cancel();
      });
      const result = await Promise.race([pending, cancelled]);
      const apiError = baiduApiError(result, endpoint.pathname);
      if (apiError) throw apiError;
      return result;
    } catch (error) {
      // Retain a server risk response even if a peer failed and cancelled this
      // file at the same instant; cancellation must not erase the shared circuit.
      baiduUploadRequestGate.observe(error);
      options.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const transient = /超时|net::ERR_(?:CONNECTION|TIMED_OUT|NETWORK|INTERNET|NAME_NOT_RESOLVED|HTTP2)|HTTP (?:408|429|5\d\d)/i.test(message);
      if (message.includes(BAIDU_RISK_CONTROL_MARKER) || !transient || attempt >= attempts)
        throw new Error(`${label}失败（尝试 ${attempt} 次）：${message.split("\n")[0]}`);
      options.onRetry?.(`${label}请求失败，正在重试（${attempt + 1}/${attempts}）`);
    } finally {
      if (cancel) options.signal?.removeEventListener("abort", cancel);
    }
    await delay(attempt * 1_000, undefined, { signal: options.signal });
  }
}
