import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { compileFunction, createContext, runInNewContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { uploadBaiduNetdiskDirectory } from "../../src/workflows/upload-directory.js";
import type { RemoteVerifiedFile } from "../../src/workflows/upload-verification.js";

test(
  "verifies uploads, reuses a legacy attempt under the canonical name, and cleans only this version duplicates",
  { timeout: 50_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baidu-upload-"));
    const server = createServer((_request, response) => {
      const address = server.address() as { port: number };
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify([
          {
            id: "core",
            url: "file:///core.asar/index.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
          },
        ]),
      );
    });
    const sockets = new WebSocketServer({ server });
    type Remote = {
      server_filename: string;
      path: string;
      fs_id: number;
      isdir: number;
      size: number;
      md5?: string;
      server_mtime: number;
    };
    const files = new Map<string, Remote>();
    const blocks = new Map<number, Buffer>();
    const remoteContents = new Map<string, Buffer>();
    const receipts: RemoteVerifiedFile[] = [];
    let contentReads = 0;
    let shares = 0;
    let nextFsId = 1;
    const deletedPaths: string[] = [];
    const moveTree = (from: string, to: string) => {
      for (const [oldPath, file] of [...files]) {
        if (oldPath !== from && !oldPath.startsWith(from + "/")) continue;
        const newPath = to + oldPath.slice(from.length);
        files.delete(oldPath);
        files.set(newPath, { ...file, path: newPath, server_filename: path.posix.basename(newPath) });
        const content = remoteContents.get(oldPath);
        if (content) { remoteContents.delete(oldPath); remoteContents.set(newPath, content); }
      }
    };
    const uploadedIndexes: number[] = [];
    const requestTimeouts: number[] = [];
    const md5 = (value: Buffer) => createHash("md5").update(value).digest("hex");
    const clientMd5 = (plain: string) => {
      const swapped = plain.slice(8, 16) + plain.slice(0, 8) + plain.slice(24, 32) + plain.slice(16, 24);
      const chars = Array.from(swapped, (char, index) => (Number.parseInt(char, 16) ^ (index & 15)).toString(16));
      chars[9] = String.fromCharCode("g".charCodeAt(0) + Number.parseInt(chars[9], 16));
      return chars.join("");
    };
    const handle = (rawUrl: string, payload: Buffer) => {
      const url = new URL(rawUrl);
      const form = new URLSearchParams(payload.toString());
      if (url.pathname.endsWith("gettemplatevariable"))
        return { errno: 0, result: { bdstoken: "test-token" } };
      if (url.pathname.endsWith("/list"))
        return {
          errno: 0,
          list: [...files.values()].filter(
            (file) => path.posix.dirname(file.path) === url.searchParams.get("dir"),
          ).map(file => ({ ...file, md5: file.md5 ? clientMd5(file.server_filename.endsWith(".mp4") ? "f".repeat(32) : file.md5) : undefined })),
        };
      if (url.pathname.endsWith("/filemetas")) {
        const target = JSON.parse(url.searchParams.get("target")!)[0];
        const file = files.get(target)!;
        return { errno: 0, info: [{ ...file, md5: "f".repeat(32), dlink: `https://d.pcs.baidu.com/verify-content?path=${encodeURIComponent(target)}` }] };
      }
      if (url.pathname === "/verify-content") {
        contentReads++;
        return { rawBody: remoteContents.get(url.searchParams.get("path")!)! };
      }
      if (url.pathname.endsWith("/filemanager")) {
        const entries = JSON.parse(form.get("filelist")!);
        if (url.searchParams.get("opera") === "delete") {
          for (const target of entries) {
            deletedPaths.push(target);
            for (const file of [...files.keys()]) if (file === target || file.startsWith(target + "/")) {
              files.delete(file); remoteContents.delete(file);
            }
          }
        } else if (url.searchParams.get("opera") === "rename") {
          for (const entry of entries) moveTree(entry.path, path.posix.join(path.posix.dirname(entry.path), entry.newname));
        } else throw new Error("Unexpected mutation");
        return { errno: 0 };
      }
      if (url.pathname.endsWith("/precreate")) {
        blocks.clear();
        const hashes = JSON.parse(form.get("block_list")!);
        return {
          errno: 0,
          return_type: 1,
          uploadid: "upload-1",
          block_list: hashes.map((_hash: string, index: number) => index),
        };
      }
      if (url.pathname.endsWith("/superfile2")) {
        const start = payload.indexOf("\r\n\r\n") + 4;
        const end = payload.lastIndexOf("\r\n--");
        const block = payload.subarray(start, end);
        const index = Number(url.searchParams.get("partseq"));
        blocks.set(index, block);
        uploadedIndexes.push(index);
        return { md5: md5(block) };
      }
      if (url.pathname.endsWith("/create")) {
        const destination = form.get("path")!;
        const isdir = Number(form.get("isdir"));
        const content = Buffer.concat(
          [...blocks.entries()].sort(([left], [right]) => left - right).map(([, buffer]) => buffer),
        );
        const file = {
          server_filename: path.posix.basename(destination),
          path: destination,
          fs_id: nextFsId++,
          isdir,
          size: isdir ? 0 : Number(form.get("size")),
          md5: isdir ? undefined : md5(content),
          server_mtime: 1,
        };
        files.set(destination, file);
        if (!isdir) remoteContents.set(destination, content);
        return { errno: 0, ...file };
      }
      if (url.pathname.endsWith("/share/set")) {
        shares++;
        assert.ok(files.has("/快手_二创集合/原剧/新剧-60%/成片/新剧-第1集.mp4"));
        return { errno: 0, shareid: 123, link: "https://pan.baidu.com/s/1test" };
      }
      throw new Error(`Unhandled test URL ${rawUrl}`);
    };
    const net = {
      request: (options: { url: string; useSessionCookies: boolean }) => {
        assert.equal(options.useSessionCookies, true);
        const request = new EventEmitter() as EventEmitter & {
          setHeader: () => void;
          write: (buffer: Buffer) => void;
          abort: () => void;
          end: () => void;
        };
        let payload = Buffer.alloc(0);
        request.setHeader = () => undefined;
        request.write = (buffer) => {
          payload = buffer;
        };
        request.abort = () => undefined;
        request.end = () =>
          queueMicrotask(() => {
            try {
              const data = handle(options.url, payload);
              request.emit("close"); // Real Baidu event order: request closes before response completion.
              const response = Object.assign(new EventEmitter(), { statusCode: 200 });
              request.emit("response", response);
              response.emit("data", "rawBody" in data ? data.rawBody : Buffer.from(JSON.stringify(data)));
              response.emit("end");
            } catch (error) {
              request.emit("error", error);
            }
          });
        return request;
      },
    };
    const contents = { id: 1, getURL: () => "https://pan.baidu.com/disk/main", session: {} };
    const electron = { net, webContents: { getAllWebContents: () => [contents], fromId: () => contents } };
    const mainContext = createContext({
      Buffer, URL, clearTimeout,
      setTimeout: (callback: () => void, ms: number) => {
        requestTimeouts.push(ms);
        return setTimeout(callback, ms);
      },
    });
    sockets.on("connection", (socket) =>
      socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString());
        try {
          const value =
            message.method === "Runtime.evaluate"
              ? await runInNewContext(message.params.expression, {
                  Buffer,
                  URL,
                  setTimeout: (callback: () => void, ms: number) => {
                    requestTimeouts.push(ms);
                    return setTimeout(callback, ms);
                  },
                  clearTimeout,
                  require: () => ({
                    getCurrentWebContents: () => contents,
                    require: (module: string) => module === "electron" ? electron : module === "crypto" ? { createHash } : {
                      compileFunction: (code: string, parameters: string[]) => compileFunction(code, parameters, { parsingContext: mainContext }),
                      runInThisContext: (expression: string) => runInContext(expression, mainContext),
                    },
                  }),
                })
              : undefined;
          socket.send(
            JSON.stringify({
              id: message.id,
              result: message.method === "Runtime.evaluate" ? { result: { value } } : {},
            }),
          );
        } catch (error) {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { exceptionDetails: { text: String(error) } },
            }),
          );
        }
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await mkdir(path.join(directory, "成片"));
      await mkdir(path.join(directory, "封面"));
      const cover = Buffer.from("test cover bytes");
      await writeFile(path.join(directory, "封面", "封面.png"), cover);
      const video = Buffer.alloc(4 * 1024 * 1024 + 123, 7);
      await writeFile(path.join(directory, "成片", "新剧-第1集.mp4"), video);
      const options = {
        port: (server.address() as { port: number }).port,
        localDirectory: directory,
        remoteDirectory: "/快手_二创集合/原剧/新剧-60%",
        verifiedFiles: receipts,
        onFileVerified: (file: RemoteVerifiedFile) => { receipts.push(file); },
      };
      const result = await uploadBaiduNetdiskDirectory(options);
      assert.equal(result.shareUrl, "https://pan.baidu.com/s/1test");
      assert.match(result.extractionCode, /^[a-f0-9]{4}$/);
      assert.deepEqual([...uploadedIndexes].sort(), [0, 0, 1]);
      assert.equal(requestTimeouts.filter(ms => ms === 600_000).length, 4); // Three upload blocks and one content readback.
      assert.equal(files.get(`${options.remoteDirectory}/封面/封面.png`)?.md5, md5(cover));
      assert.equal(files.get(`${options.remoteDirectory}/成片/新剧-第1集.mp4`)?.md5, md5(video));
      const base = options.remoteDirectory;
      const legacy = base + "汇总（2）";
      moveTree(base, legacy);
      for (const receipt of receipts) receipt.path = legacy + receipt.path.slice(base.length);
      const folder = (target: string): Remote => ({ server_filename: path.posix.basename(target), path: target, fs_id: nextFsId++, isdir: 1, size: 0, server_mtime: 1 });
      files.set(base, folder(base));
      files.set(`${base}/未知.txt`, { ...folder(`${base}/未知.txt`), isdir: 0, size: 1 });
      files.set(base + "汇总", folder(base + "汇总"));
      const unrelated = "/快手_二创集合/其他剧/其他版本-60%";
      files.set(unrelated, folder(unrelated));
      const uploadCountBefore = uploadedIndexes.length;
      let selected = "";
      const isolated = await uploadBaiduNetdiskDirectory({ ...options, preferredRemoteDirectory: legacy, onRemoteDirectorySelected: directory => { selected = directory; } });
      assert.equal(isolated.remotePath, base);
      assert.equal(selected, base);
      assert.equal(files.get(`${base}/成片/新剧-第1集.mp4`)?.md5, md5(video));
      assert.equal(uploadedIndexes.length, uploadCountBefore, "legacy uploaded files are reused without retransmission");
      assert.ok(!files.has(`${base}/未知.txt`));
      assert.ok(!files.has(legacy) && !files.has(base + "汇总"));
      assert.ok(files.has(unrelated), "other dramas and versions are preserved");
      assert.ok(!deletedPaths.includes(unrelated));
      assert.equal(shares, 2);
      const uploadCount = uploadedIndexes.length;
      const retry = await uploadBaiduNetdiskDirectory({ ...options, preferredRemoteDirectory: isolated.remotePath });
      assert.equal(retry.remotePath, isolated.remotePath);
      assert.equal(uploadedIndexes.length, uploadCount, "verified files are not uploaded again");
      assert.equal(contentReads, 1, "persisted verification receipts avoid repeated content downloads");
      assert.equal(shares, 3);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
