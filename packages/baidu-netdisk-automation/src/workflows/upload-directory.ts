import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getTargets, withPage } from "../infrastructure/cdp.js";
import { clientUploadRequest } from "../infrastructure/upload-request.js";
import { assertRecreationVersionDirectory, planUploadDirectory, uploadBlockSize, type RemoteUploadEntry } from "./upload-directory-plan.js";
import { OWN_NETDISK_DIR_LIST_PAGE_SIZE } from "../domain/constants.js";
import { normalizeBaiduMd5 } from "../domain/file-checksum.js";
import { createRemoteFileVerifier, type RemoteVerifiedFile, type RemoteVerificationEntry } from "./upload-verification.js";

export async function uploadBaiduNetdiskDirectory(options: {
  port: number;
  localDirectory: string;
  remoteDirectory: string;
  preferredRemoteDirectory?: string;
  onRemoteDirectorySelected?: (directory: string) => void | Promise<void>;
  verifiedFiles?: RemoteVerifiedFile[];
  onFileVerified?: (file: RemoteVerifiedFile) => void;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ remotePath: string; shareUrl: string; extractionCode: string }> {
  assertRecreationVersionDirectory(options.remoteDirectory);
  const core = (await getTargets(options.port)).find(
    (target) =>
      target.webSocketDebuggerUrl &&
      target.url.includes("core.asar") &&
      !/#\/(?:bubble_menu|sestonMenu|workspace)/.test(target.url),
  );
  if (!core) throw new Error("请先启动百度网盘 CDP 模式并登录");
  return withPage(core, async (page) => {
    const clientRequest = (url: string, body?: Buffer, contentType?: string, label?: string) =>
      clientUploadRequest(page, url, body, contentType, {
        signal: options.signal,
        onRetry: options.onProgress,
        ...(label ? { label, timeoutMs: 600_000, retryable: true } : {}),
      });
    const tokenResult = await clientRequest(
      "https://pan.baidu.com/api/gettemplatevariable?clienttype=0&web=1&fields=%5B%22bdstoken%22%5D",
    );
    const token = String((tokenResult.result as { bdstoken?: string } | undefined)?.bdstoken || "");
    if (!token) throw new Error("百度网盘登录已失效，请登录客户端后重试");
    const api = async (
      endpoint: string,
      form: Record<string, string>,
      query: Record<string, string> = {},
    ) => {
      options.signal?.throwIfAborted();
      const params = new URLSearchParams({
        app_id: "250528",
        web: "1",
        clienttype: "0",
        bdstoken: token,
        ...query,
      });
      return clientRequest(
        `https://pan.baidu.com${endpoint}?${params}`,
        Buffer.from(new URLSearchParams(form).toString()),
        "application/x-www-form-urlencoded",
      );
    };
    const list = async (dir: string) => {
      const files: Array<{
        server_filename: string;
        path: string;
        fs_id: number;
        isdir: number;
        size: number;
        md5?: string;
        server_mtime?: number;
      }> = [];
      for (let pageNumber = 1; ; pageNumber++) {
        options.signal?.throwIfAborted();
        const params = new URLSearchParams({
          dir,
          page: String(pageNumber),
          num: String(OWN_NETDISK_DIR_LIST_PAGE_SIZE),
          web: "1",
          bdstoken: token,
          order: "name",
        });
        const response = await clientRequest(`https://pan.baidu.com/api/list?${params}`);
        const batch = response.list as typeof files;
        if (!Array.isArray(batch)) throw new Error(`无法读取网盘目录：${dir}`);
        files.push(...batch.map(file => ({ ...file, md5: normalizeBaiduMd5(file.md5) })));
        if (!response.has_more && batch.length < OWN_NETDISK_DIR_LIST_PAGE_SIZE) return files;
      }
    };
    const verifyFile = createRemoteFileVerifier({
      saved: options.verifiedFiles,
      onVerified: options.onFileVerified,
      metadata: async remotePath => {
        const params = new URLSearchParams({ target: JSON.stringify([remotePath]), dlink: "1", bdstoken: token, web: "1" });
        const response = await clientRequest(`https://pan.baidu.com/api/filemetas?${params}`);
        return (response.info as RemoteVerificationEntry[] | undefined)?.find(file => file.path === remotePath);
      },
      contentChecksum: async (url, size, remotePath) => {
        const label = `回读校验 ${path.posix.basename(remotePath)}`;
        options.onProgress?.(label);
        const result = await clientUploadRequest(page, url, undefined, undefined, {
          signal: options.signal, onRetry: options.onProgress, label,
          responseType: "checksum", expectedSize: size, timeoutMs: 600_000,
        });
        if (typeof result.size !== "number" || typeof result.md5 !== "string") throw new Error("网盘回读校验结果无效");
        return { size: result.size, md5: result.md5 };
      },
    });
    let parent = "/";
    for (const segment of path.posix.dirname(options.remoteDirectory).split("/").filter(Boolean)) {
      const destination = path.posix.join(parent, segment);
      const existing = (await list(parent)).find((file) => file.server_filename === segment);
      if (existing && !existing.isdir) throw new Error(`网盘存在同名文件：${destination}`);
      if (!existing) {
        await api(
          "/api/create",
          { path: destination, isdir: "1", block_list: "[]" },
          { a: "commit" },
        );
      }
      parent = destination;
    }
    options.onProgress?.("校验本地文件并选择可复用的网盘目录");
    const plan = await planUploadDirectory({ ...options, list, verifyFile });
    const remoteDirectory = plan.remoteDirectory;
    await options.onRemoteDirectorySelected?.(remoteDirectory);
    const legacyPaths = new Set(plan.legacyDirectories.map(entry => entry.path));
    const deleteEntries = async (entries: RemoteUploadEntry[]) => {
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        if (entry.path !== remoteDirectory && !entry.path.startsWith(remoteDirectory + "/") && !legacyPaths.has(entry.path))
          throw new Error("拒绝清理当前二创版本范围以外的网盘文件");
        const current = (await list(path.posix.dirname(entry.path))).find(file => file.path === entry.path);
        if (!current) continue;
        if (!entry.fs_id || String(current.fs_id) !== String(entry.fs_id)) throw new Error(`网盘文件已变化，停止清理：${entry.path}`);
        options.onProgress?.(`清理重复或冲突内容：${path.posix.basename(entry.path)}`);
        await api("/api/filemanager", { filelist: JSON.stringify([entry.path]) }, { opera: "delete", async: "2", onnest: "fail" });
        let missing = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!(await list(path.posix.dirname(entry.path))).some(file => file.path === entry.path)) { missing = true; break; }
          await delay(500, undefined, { signal: options.signal });
        }
        if (!missing) throw new Error(`网盘尚未确认清理完成，请稍后重试：${entry.path}`);
      }
    };
    if (plan.reuseFrom) {
      if (plan.existing) await deleteEntries([plan.existing]);
      options.onProgress?.("复用已上传内容，恢复固定版本目录名");
      const current = (await list(parent)).find(file => file.path === plan.reuseFrom!.path);
      if (!current || String(current.fs_id) !== String(plan.reuseFrom.fs_id)) throw new Error("待复用的网盘版本目录已变化，请重试");
      await api("/api/filemanager", { filelist: JSON.stringify([{ path: plan.reuseFrom.path, newname: path.posix.basename(remoteDirectory) }]) },
        { opera: "rename", async: "2", onnest: "fail" });
      let renamed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const entries = await list(parent);
        if (!entries.some(entry => entry.path === plan.reuseFrom!.path)
          && entries.some(entry => entry.path === remoteDirectory && String(entry.fs_id) === String(plan.reuseFrom!.fs_id))) { renamed = true; break; }
        await delay(500, undefined, { signal: options.signal });
      }
      if (!renamed) throw new Error("网盘尚未确认版本目录重命名完成，请稍后重试");
      verifyFile.relocate(plan.reuseFrom.path, remoteDirectory);
    }
    await deleteEntries(plan.conflicts);
    const existingDirectory = (await list(parent)).find(file => file.path === remoteDirectory);
    const directory = existingDirectory ?? await api("/api/create", { path: remoteDirectory, isdir: "1", block_list: "[]" }, { a: "commit" });
    const directoryId = Number(directory.fs_id);
    const uploadFile = async (local: string, destination: string) => {
      options.signal?.throwIfAborted();
      const info = await stat(local);
      if (!info.size) throw new Error(`素材文件为空：${local}`);
      options.onProgress?.(`上传 ${path.basename(local)}`);
      const handle = await open(local, "r");
      try {
        const blockSize = uploadBlockSize;
        const identity = plan.identities.get(local);
        if (!identity || identity.size !== info.size || identity.modifiedAtMs !== info.mtimeMs)
          throw new Error(`素材文件在上传前发生变化：${local}`);
        const hashes = identity.hashes;
        const readBlock = async (index: number) => {
          const buffer = Buffer.alloc(Math.min(blockSize, info.size - index * blockSize));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, index * blockSize);
          if (bytesRead !== buffer.length) throw new Error(`素材文件在上传中发生变化：${local}`);
          return buffer;
        };
        const siblings = await list(path.posix.dirname(destination));
        const existing = siblings.find((file) => file.path === destination);
        if (existing) {
          if (await verifyFile(existing, identity))
            return;
          throw new Error(`网盘文件在预检后发生变化，请重试以清理冲突内容：${destination}`);
        }
        const pre = await api("/api/precreate", {
          path: destination,
          size: String(info.size),
          isdir: "0",
          autoinit: "1",
          block_list: JSON.stringify(hashes),
        });
        if (pre.return_type !== 2) {
          if (typeof pre.uploadid !== "string" || !pre.uploadid || !Array.isArray(pre.block_list))
            throw new Error("百度网盘未返回有效上传会话");
          for (const index of pre.block_list as number[]) {
            options.signal?.throwIfAborted();
            if (!Number.isInteger(index) || index < 0 || index >= hashes.length)
              throw new Error("百度网盘返回无效分片序号");
            const block = await readBlock(index);
            const boundary = `dramabridge${randomBytes(12).toString("hex")}`;
            const payload = Buffer.concat([
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
              ),
              block,
              Buffer.from(`\r\n--${boundary}--\r\n`),
            ]);
            const params = new URLSearchParams({
              method: "upload",
              app_id: "250528",
              type: "tmpfile",
              path: destination,
              uploadid: pre.uploadid,
              partseq: String(index),
            });
            const progress = `上传 ${path.basename(local)} 分片 ${index + 1}/${hashes.length}`;
            options.onProgress?.(progress);
            const uploaded = await clientRequest(
              `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?${params}`,
              payload,
              `multipart/form-data; boundary=${boundary}`,
              progress,
            );
            if (normalizeBaiduMd5(uploaded.md5) !== hashes[index])
              throw new Error(`上传分片校验失败：${destination} #${index}`);
          }
          await api(
            "/api/create",
            {
              path: destination,
              size: String(info.size),
              isdir: "0",
              uploadid: pre.uploadid,
              block_list: JSON.stringify(hashes),
            },
            { a: "commit" },
          );
        }
        const verified = (await list(path.posix.dirname(destination))).find(
          (file) => file.path === destination,
        );
        if (!verified || !(await verifyFile(verified, identity)))
          throw new Error(`网盘文件校验失败：${destination}`);
      } finally {
        await handle.close();
      }
    };
    const uploadTree = async (local: string, destination: string) => {
      const entries = await readdir(local, { withFileTypes: true });
      const allowed = new Set(entries.map((entry) => entry.name));
      const unexpected = (await list(destination)).find(
        (file) => !allowed.has(file.server_filename),
      );
      if (unexpected)
        throw new Error(`目标版本目录存在额外文件，为避免分享错误素材已停止：${unexpected.path}`);
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        const remote = path.posix.join(destination, entry.name);
        if (entry.isDirectory()) {
          const existing = (await list(destination)).find((file) => file.path === remote);
          if (existing && !existing.isdir) throw new Error(`网盘存在同名文件：${remote}`);
          if (!existing)
            await api(
              "/api/create",
              { path: remote, isdir: "1", block_list: "[]" },
              { a: "commit" },
            );
          await uploadTree(path.join(local, entry.name), remote);
        } else if (entry.isFile()) await uploadFile(path.join(local, entry.name), remote);
        else throw new Error("不支持上传符号链接素材");
      }
    };
    await uploadTree(options.localDirectory, remoteDirectory);
    if (!directoryId) throw new Error("上传目录缺少文件 ID");
    // Canonical content is complete and verified before removing old duplicate attempts.
    await deleteEntries(plan.legacyDirectories);
    options.onProgress?.("创建版本分享链接");
    const extractionCode = randomBytes(2).toString("hex");
    const shared = await api("/share/set", {
      fid_list: JSON.stringify([directoryId]),
      schannel: "4",
      channel_list: "[]",
      period: "0",
      pwd: extractionCode,
    });
    const shareUrl = typeof shared.link === "string" ? shared.link : "";
    if (!/^https?:\/\/pan\.baidu\.com\/s\//.test(shareUrl) || !shared.shareid)
      throw new Error("百度网盘未确认生成有效分享链接");
    // Keep the client task surface alive for the platform's minimum settle period.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return { remotePath: remoteDirectory, shareUrl, extractionCode };
  });
}
