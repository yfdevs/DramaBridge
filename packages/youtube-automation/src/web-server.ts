import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { allowedYoutubeRequest, type Json } from "./index.js";

type WebOptions = {
  port: number;
  directory: string;
  status: () => Json;
  request: (route: string, body?: Json) => Promise<Json>;
};
const json = (response: ServerResponse, code: number, value: unknown) => {
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
};
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new Error("请求格式无效");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new Error("请求过大");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效");
  return value as Record<string, unknown>;
}
export class YoutubeWebServer {
  private server?: Server;
  private starting?: Promise<void>;
  private addresses: string[] = [];
  urls() {
    return [...this.addresses];
  }
  start(options: WebOptions): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve();
    this.starting = this.launch(options).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async launch(options: WebOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
      throw new Error("Web 端口应为 1–65535");
    await stat(path.join(options.directory, "youtube-web.html"));
    const ips = [
      ...new Set([
        "127.0.0.1",
        ...Object.values(networkInterfaces()).flatMap((items) =>
          (items ?? [])
            .filter((item) => item.family === "IPv4" && !item.internal)
            .map((item) => item.address),
        ),
      ]),
    ];
    const hosts = new Set([...ips, "localhost"].map((ip) => `${ip}:${options.port}`));
    const server = createServer((request, response) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      void (async () => {
        const host = request.headers.host ?? "";
        if (
          !hosts.has(host) ||
          (request.headers.origin && request.headers.origin !== `http://${host}`)
        ) {
          json(response, 403, { error: "访问来源无效" });
          return;
        }
        const route = new URL(request.url ?? "/", `http://${host}`).pathname;
        if (route.startsWith("/web-api/")) {
          if (route === "/web-api/status" && request.method === "GET") {
            json(response, 200, options.status());
            return;
          }
          if (route === "/web-api/request" && request.method === "POST") {
            const input = await body(request),
              endpoint = input.route;
            const post = input.body !== undefined;
            if (
              typeof endpoint !== "string" ||
              !allowedYoutubeRequest(endpoint, post) ||
              endpoint === "/api/netdisk/start" ||
              (endpoint === "/api/settings" &&
                (!input.body ||
                  typeof input.body !== "object" ||
                  Array.isArray(input.body) ||
                  Object.keys(input.body).some((key) => key !== "paused") ||
                  typeof (input.body as { paused?: unknown }).paused !== "boolean"))
            ) {
              json(response, 403, { error: "不支持的 Web 操作" });
              return;
            }
            let payload = input.body as Json | undefined;
            if (endpoint === "/api/tasks" && post) {
              if (!payload || typeof payload !== "object" || Array.isArray(payload))
                throw new Error("任务格式无效");
              payload = { ...payload, noUpload: false };
            }
            let value = await options.request(endpoint, payload);
            if (
              endpoint === "/api/tasks" &&
              !post &&
              value &&
              typeof value === "object" &&
              !Array.isArray(value)
            ) {
              const settings = (value.settings ?? {}) as { paused?: boolean };
              value = { ...value, settings: { paused: Boolean(settings.paused) } };
            }
            if (
              endpoint === "/api/oauth/start" &&
              value &&
              typeof value === "object" &&
              !Array.isArray(value)
            )
              value = { ...value, manual: true };
            json(response, 200, value);
            return;
          }
          json(response, 404, { error: "接口不存在" });
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          json(response, 405, { error: "请求方法无效" });
          return;
        }
        let file: string;
        if (route === "/" || route === "/youtube-web.html") file = "youtube-web.html";
        else if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(route)) file = route.slice(1);
        else {
          json(response, 404, { error: "页面不存在" });
          return;
        }
        const filePath = path.join(options.directory, file);
        const info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) {
          json(response, 404, { error: "文件不存在" });
          return;
        }
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".ttf": "font/ttf",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        response.writeHead(200, {
          "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
          "Content-Length": info.size,
          "Cache-Control": file.endsWith(".html")
            ? "no-store"
            : "public, max-age=31536000, immutable",
        });
        if (request.method === "HEAD") response.end();
        else
          createReadStream(filePath)
            .on("error", () => response.destroy())
            .pipe(response);
      })().catch((error) => {
        if (!response.headersSent) json(response, 400, { error: (error as Error).message });
        else response.end();
      });
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "0.0.0.0", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      server.close();
      throw error;
    }
    this.server = server;
    this.addresses = ips.map((ip) => `http://${ip}:${options.port}`);
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.addresses = [];
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
}
