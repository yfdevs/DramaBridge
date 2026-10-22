import { createServer, type Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";

export type LocalApiSettings = { enabled: boolean; port: number };
export type LocalApiRequest = { method: string; url: URL; body: unknown; signal: AbortSignal };
export type LocalApiResponse = { status?: number; data: unknown };
export type LocalApiHandler = (request: LocalApiRequest) => Promise<LocalApiResponse>;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Loopback transport. Platform workflows remain in their platform modules. */
export class LocalApiServer {
  private server?: Server;
  private port?: number;
  private aborter?: AbortController;
  private operation: Promise<unknown> = Promise.resolve();
  private lastError?: string;
  constructor(private readonly handler: LocalApiHandler) {}

  status() {
    return {
      running: Boolean(this.server?.listening),
      baseUrl: this.port ? `http://127.0.0.1:${this.port}/api` : undefined,
      error: this.lastError,
    };
  }

  configure(settings: LocalApiSettings): Promise<void> {
    const operation = this.operation.catch(() => undefined).then(() => this.apply(settings));
    this.operation = operation;
    return operation;
  }

  close() {
    return this.configure({ enabled: false, port: this.port ?? 18439 });
  }

  private async apply(settings: LocalApiSettings) {
    if (!settings.enabled) {
      await this.closeServer();
      this.lastError = undefined;
      return;
    }
    if (
      !Number.isInteger(settings.port) ||
      settings.port < 1 ||
      settings.port > 65535
    ) {
      throw new HttpError(400, "INVALID_API_SETTINGS", "服务端口必须是 1～65535 的整数");
    }
    if (this.server?.listening && this.port === settings.port) {
      this.lastError = undefined;
      return;
    }
    const aborter = new AbortController();
    const api = express();
    api.disable("x-powered-by");
    const server = createServer(api);
    api.use((request, response, next) => {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (aborter.signal.aborted) throw new HttpError(503, "SERVICE_STOPPED", "服务已关闭");
      if (request.headers.origin)
        throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "仅允许本机程序调用");
      if (
        ![`127.0.0.1:${settings.port}`, `localhost:${settings.port}`].includes(
          request.headers.host ?? "",
        )
      ) {
        throw new HttpError(403, "INVALID_HOST", "请求地址无效");
      }
      if (request.method === "POST" && !request.is("application/json"))
        throw new HttpError(415, "JSON_REQUIRED", "请求需使用 application/json");
      next();
    });
    api.use(express.json({ limit: "64kb", strict: true, inflate: false }));
    api.use(async (request, response) => {
      const requestAborter = new AbortController();
      const stopped = () => requestAborter.abort();
      aborter.signal.addEventListener("abort", stopped, { once: true });
      response.once("close", stopped);
      try {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${settings.port}`);
        if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "NOT_FOUND", "接口不存在");
        const result = await this.handler({
          method: request.method ?? "GET",
          url,
          body: request.body,
          signal: requestAborter.signal,
        });
        response
          .status(result.status ?? 200)
          .json({ success: (result.status ?? 200) < 400, data: result.data });
      } finally {
        aborter.signal.removeEventListener("abort", stopped);
        response.off("close", stopped);
      }
    });
    const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
      if (response.destroyed || response.headersSent) return;
      const failure = error as {
        statusCode?: number;
        status?: number;
        code?: string;
        message?: string;
        type?: string;
      };
      const code =
        failure.type === "entity.parse.failed"
          ? "INVALID_JSON"
          : failure.type === "entity.too.large"
            ? "REQUEST_TOO_LARGE"
            : (failure.code ?? "INTERNAL_ERROR");
      const message =
        code === "INVALID_JSON"
          ? "请求 JSON 格式错误"
          : code === "REQUEST_TOO_LARGE"
            ? "请求内容超过 64 KiB"
            : (failure.message ?? "请求处理失败");
      response
        .status(failure.statusCode ?? failure.status ?? 500)
        .json({ success: false, error: { code, message } });
    };
    api.use(errorHandler);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(settings.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.lastError = `本机接口启动失败：${(error as NodeJS.ErrnoException).code === "EADDRINUSE" ? `端口 ${settings.port} 已被占用` : String(error)}`;
      throw new Error(this.lastError);
    }
    await this.closeServer();
    this.port = settings.port;
    this.aborter = aborter;
    this.server = server;
    this.lastError = undefined;
    server.on("error", (error) => {
      this.lastError = `本机接口异常：${error.message}`;
    });
  }

  private async closeServer() {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.aborter?.abort();
    this.aborter = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => server.closeAllConnections(), 1_000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections();
    });
  }
}
