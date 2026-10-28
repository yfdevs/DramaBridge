import WebSocket from "ws";
import { Effect } from "effect";

import { debugHost } from "../domain/constants.js";
import { CdpConnectionError, CdpTimeoutError, cdpConnectionError } from "../domain/errors.js";
import { pollUntil, runPromisePreservingFailure, scopedResource } from "../runtime/effect-runtime.js";
import type { CdpMessage, CdpTarget } from "../domain/types.js";
import { getJson, websocketDataToString } from "./utils.js";

export async function getTargets(port: number) {
  return getJson<CdpTarget[]>(`http://${debugHost}:${port}/json/list`);
}

async function isBaiduCdpPort(port: number) {
  try {
    const version = await getJson<{ "User-Agent"?: string }>(
      `http://${debugHost}:${port}/json/version`,
    );
    const targets = await getTargets(port);
    const userAgent = version["User-Agent"] ?? "";
    const hasBaiduTarget = targets.some(
      (target) =>
        target.url.includes("BaiduNetdisk") ||
        target.url.includes("core.asar") ||
        target.url.includes("pan.baidu.com"),
    );
    return /baidunetdisk/i.test(userAgent) || hasBaiduTarget;
  } catch {
    return false;
  }
}

export async function ensureBaiduCdpPort(port: number) {
  if (await isBaiduCdpPort(port)) return;
  throw new Error(
    `端口 ${port} 不是可用百度网盘 CDP。请先退出百度网盘，再手动启动 module\\BrowserEngine\\BaiduNetdiskUnite.exe --remote-debugging-port=${port}。`,
  );
}

export class CdpPage {
  private nextId = 0;
  private socket: WebSocket;
  private closed = false;
  private consoleListeners = new Set<(message: string) => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data: unknown) => {
      if (this.consoleListeners.size === 0) return;
      const message = JSON.parse(websocketDataToString(data)) as CdpMessage;
      if (message.method !== "Runtime.consoleAPICalled") return;
      const text = (message.params?.args ?? [])
        .map((argument) => {
          const value = argument.value;
          if (value === undefined) return argument.description ?? "";
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
          ) {
            return String(value);
          }
          if (value === null) return "null";
          try {
            return JSON.stringify(value);
          } catch {
            return argument.description ?? "";
          }
        })
        .join(" ");
      for (const listener of this.consoleListeners) listener(text);
    });
    this.socket.on("close", () => {
      this.closed = true;
    });
    // Keep transport errors from becoming unhandled EventEmitter errors after
    // open() removes its temporary listener. Pending calls fail on close.
    this.socket.on("error", () => undefined);
  }

  onConsole(listener: (message: string) => void) {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  async open() {
    await new Promise<void>((resolve, reject) => {
      // oxlint-disable-next-line prefer-const
      let timeout: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("CDP WebSocket 连接失败。"));
      };

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("CDP WebSocket 连接超时。"));
      }, 10000);

      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable").catch(() => undefined);
  }

  close() {
    if (!this.closed) this.socket.close();
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000) {
    if (this.closed) throw new Error("CDP 页面已关闭。");

    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("message", onMessage);
        this.socket.off("close", onClose);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("CDP 页面已关闭。"));
      };
      const onMessage = (data: unknown) => {
        const message = JSON.parse(websocketDataToString(data)) as CdpMessage;
        if (message.id !== id) return;

        cleanup();
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result as T);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new CdpTimeoutError({
          message: `${method} 超时（${timeoutMs / 1000} 秒），网盘客户端未及时响应。`,
          operation: method,
          timeoutMs,
        }));
      }, timeoutMs);

      this.socket.on("message", onMessage);
      this.socket.once("close", onClose);

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async evaluate<T>(expression: string, timeoutMs = 60000, stage = "执行网盘脚本") {
    const response = await this.send<{
      result?: { value?: T; description?: string };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string; value?: string };
      };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    ).catch((error: unknown) => {
      if (error instanceof CdpTimeoutError) {
        throw new CdpTimeoutError({
          message: `${stage}：${error.message} 请检查网盘客户端是否卡顿或等待登录；操作结果可能尚未返回，请先核对后重试。`,
          operation: stage,
          timeoutMs,
          cause: error,
        });
      }
      throw error;
    });
    if (response.exceptionDetails) {
      throw new Error(
        `${stage}：${response.exceptionDetails.exception?.description ??
          response.exceptionDetails.exception?.value ??
          response.exceptionDetails.text ??
          "CDP 执行脚本异常。"}`,
      );
    }
    if (!response.result) throw new Error("CDP 执行脚本失败。");
    return response.result.value as T;
  }

  async navigate(url: string, timeoutMs = 15000) {
    await this.send("Page.navigate", { url }, timeoutMs);
  }

  async navigateWithoutWaiting(url: string) {
    if (this.closed) throw new Error("CDP 页面已关闭。");

    const id = ++this.nextId;
    await new Promise<void>((resolve, reject) => {
      this.socket.send(
        JSON.stringify({ id, method: "Page.navigate", params: { url } }),
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  async reloadWithoutWaiting(ignoreCache = true) {
    if (this.closed) throw new Error("CDP 页面已关闭。");

    const id = ++this.nextId;
    await new Promise<void>((resolve, reject) => {
      this.socket.send(
        JSON.stringify({ id, method: "Page.reload", params: { ignoreCache } }),
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  async clickPoint(x: number, y: number, allowPageClose = false) {
    try {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
      });
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    } catch (error) {
      if (!allowPageClose) throw error;
    }
  }

  async pressEnter() {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
}

type CdpPageResource = Pick<CdpPage, "close" | "open">;

export function openCdpPageEffect<T extends CdpPageResource = CdpPage>(
  target: CdpTarget,
  createPage: (url: string) => T = ((url: string) => new CdpPage(url)) as unknown as (url: string) => T,
): Effect.Effect<T, CdpConnectionError> {
  return Effect.tryPromise({
    try: async () => {
      if (!target.webSocketDebuggerUrl) {
        throw new Error("目标页面没有 WebSocket 调试地址。");
      }

      const page = createPage(target.webSocketDebuggerUrl);
      try {
        await page.open();
        return page;
      } catch (error) {
        // Acquisition has not completed yet, so acquireRelease cannot run this finalizer.
        page.close();
        throw error;
      }
    },
    catch: (error) => cdpConnectionError(error),
  });
}

export function withPageEffect<A, E, R, T extends CdpPageResource = CdpPage>(
  target: CdpTarget,
  run: (page: T) => Effect.Effect<A, E, R>,
  createPage?: (url: string) => T,
): Effect.Effect<A, CdpConnectionError | E, R> {
  return scopedResource({
    acquire: openCdpPageEffect(target, createPage),
    release: (page) => Effect.sync(() => page.close()),
    use: run,
  });
}

export function withPage<T>(target: CdpTarget, run: (page: CdpPage) => Promise<T>) {
  return runPromisePreservingFailure(
    withPageEffect(target, (page) =>
      Effect.tryPromise({
        try: () => run(page),
        catch: (error) => error,
      }),
    ),
  );
}

export async function waitForDocumentBody(page: CdpPage, timeoutMs = 15000) {
  const loaded = await page.evaluate<boolean>(
    `
(async () => {
  const started = Date.now();
  while (!document.body && Date.now() - started < ${timeoutMs}) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Boolean(document.body);
})()
`,
    timeoutMs + 1000,
  );

  if (!loaded) throw new Error("页面 body 未加载完成。");
}

export function waitForTargetEffect(
  port: number,
  predicate: (target: CdpTarget) => boolean,
  timeoutMs = 15000,
): Effect.Effect<CdpTarget, CdpConnectionError | CdpTimeoutError> {
  const findTarget = Effect.tryPromise({
    try: () => getTargets(port),
    catch: (error) => cdpConnectionError(error, port),
  }).pipe(
    Effect.map((targets) =>
      targets.find((item) => item.webSocketDebuggerUrl && predicate(item)),
    ),
  );

  return pollUntil(findTarget, {
    intervalMs: 300,
    timeoutMs,
    isDone: (target) => target !== undefined,
    onTimeout: () => new CdpTimeoutError({
      message: "没有找到目标页面。",
      operation: "waitForTarget",
      timeoutMs,
    }),
  }).pipe(Effect.map((target) => target as CdpTarget));
}

export function waitForTarget(
  port: number,
  predicate: (target: CdpTarget) => boolean,
  timeoutMs = 15000,
) {
  return Effect.runPromise(waitForTargetEffect(port, predicate, timeoutMs));
}
