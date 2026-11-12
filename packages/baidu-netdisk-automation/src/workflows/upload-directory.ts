import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getTargets, withPage } from "../infrastructure/cdp.js";
import { clientUploadRequest } from "../infrastructure/upload-request.js";
import {
  assertRecreationVersionDirectory,
  planUploadDirectory,
  uploadBlockSize,
  type RemoteUploadEntry,
} from "./upload-directory-plan.js";
import {
  OWN_NETDISK_DIR_LIST_PAGE_SIZE,
  OWN_NETDISK_DIR_LIST_MAX_PAGES,
} from "../domain/constants.js";
import { createUploadDirectoryCache } from "./upload-directory-cache.js";
import { baiduUploadServers, isBaiduUploadTransportError } from "./upload-servers.js";
import { normalizeBaiduMd5 } from "../domain/file-checksum.js";
import {
  createRemoteFileVerifier,
  type RemoteVerifiedFile,
  type RemoteVerificationEntry,
} from "./upload-verification.js";
import { uploadBaiduParts, UPLOAD_PART_CONCURRENCY } from "./upload-parts.js";
import { runUploadJobs, UPLOAD_FILE_CONCURRENCY } from "./upload-scheduler.js";
import {
  copyBaiduVersionFiles,
  validateBaiduVersionReuse,
  type BaiduVersionReuseSource,
} from "./copy-version-files.js";

export async function uploadBaiduNetdiskDirectory(options: {
  port: number;
  localDirectory: string;
  remoteDirectory: string;
  createShare?: boolean;
  preferredRemoteDirectory?: string;
  onRemoteDirectorySelected?: (directory: string) => void | Promise<void>;
  verifiedFiles?: RemoteVerifiedFile[];
  reuseSource?: BaiduVersionReuseSource;
  onFileVerified?: (file: RemoteVerifiedFile) => void;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ remotePath: string; shareUrl: string; extractionCode: string; verifiedEntries: RemoteUploadEntry[] }> {
  assertRecreationVersionDirectory(options.remoteDirectory);
  if (options.reuseSource)
    validateBaiduVersionReuse(options.reuseSource.remoteDirectory, options.remoteDirectory);
  const core = (await getTargets(options.port)).find(
    (target) =>
      target.webSocketDebuggerUrl &&
      target.url.includes("core.asar") &&
      !/#\/(?:bubble_menu|sestonMenu|workspace)/.test(target.url),
  );
  if (!core) throw new Error("请先启动百度网盘 CDP 模式并登录");
  return withPage(core, async (page) => {
    options.onProgress?.(
      `上传阶段统计：传输引擎 local-file-v2（${UPLOAD_FILE_CONCURRENCY} 文件 × ${UPLOAD_PART_CONCURRENCY} 分片）`,
    );
    const clientRequest = (
      url: string,
      body?: Buffer,
      contentType?: string,
      label?: string,
      signal = options.signal,
    ) =>
      clientUploadRequest(page, url, body, contentType, {
        signal,
        onRetry: options.onProgress,
        ...(label ? { label } : {}),
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
      label?: string,
      signal = options.signal,
    ) => {
      signal?.throwIfAborted();
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
        label,
        signal,
      );
    };
    const directories = createUploadDirectoryCache(async (dir) => {
      const files: RemoteUploadEntry[] = [];
      const seen = new Set<string>();
      for (let pageNumber = 1; pageNumber <= OWN_NETDISK_DIR_LIST_MAX_PAGES; pageNumber++) {
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
        for (const file of batch) {
          if (seen.has(file.path)) throw new Error(`网盘目录分页重复，已停止继续请求：${dir}`);
          seen.add(file.path);
        }
        files.push(...batch.map((file) => ({ ...file, md5: normalizeBaiduMd5(file.md5) })));
        if (
          response.has_more === false ||
          response.has_more === 0 ||
          (!response.has_more && batch.length < OWN_NETDISK_DIR_LIST_PAGE_SIZE)
        )
          return files;
      }
      throw new Error(`网盘目录超过安全分页上限：${dir}`);
    });
    const list = directories.list;
    let uploadServers: string[] = [];
    let serverDiscoveryAt = 0;
    let serverDiscovery: Promise<string[]> | undefined;
    const locateUpload = async (signal = options.signal) => {
      if (uploadServers.length && Date.now() - serverDiscoveryAt < 60_000) return uploadServers;
      // Concurrent parts share one refresh when the discovery cache expires.
      if (serverDiscovery) return serverDiscovery;
      const discovery = (async () => {
        try {
          uploadServers = baiduUploadServers(
            await clientRequest(
              "https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locateupload",
              undefined,
              undefined,
              undefined,
              signal,
            ),
          );
        } catch (error) {
          if (!isBaiduUploadTransportError(error)) throw error;
          uploadServers = baiduUploadServers(undefined);
          options.onProgress?.("上传节点发现暂不可用，使用客户端默认备用节点");
        }
        serverDiscoveryAt = Date.now();
        return uploadServers;
      })();
      serverDiscovery = discovery;
      try {
        return await discovery;
      } finally {
        if (serverDiscovery === discovery) serverDiscovery = undefined;
      }
    };
    const metadata = async (remotePath: string, signal = options.signal) => {
      const params = new URLSearchParams({
        target: JSON.stringify([remotePath]),
        dlink: "1",
        bdstoken: token,
        web: "1",
      });
      const response = await clientRequest(
        `https://pan.baidu.com/api/filemetas?${params}`,
        undefined,
        undefined,
        undefined,
        signal,
      );
      return (response.info as RemoteVerificationEntry[] | undefined)?.find(
        (file) => file.path === remotePath,
      );
    };
    const taskReceipts = new Map(options.verifiedFiles?.map((file) => [file.path, file]));
    const onVerified = (file: RemoteVerifiedFile) => {
      taskReceipts.set(file.path, file);
      options.onFileVerified?.(file);
    };
    const createVerifier = () =>
      createRemoteFileVerifier({
        saved: [...taskReceipts.values()],
        onVerified,
        metadata,
        contentChecksum: async (url, size, remotePath, signal = options.signal) => {
          const label = `回读校验 ${path.posix.basename(remotePath)}`;
          options.onProgress?.(label);
          const result = await clientUploadRequest(page, url, undefined, undefined, {
            signal,
            onRetry: options.onProgress,
            label,
            responseType: "checksum",
            expectedSize: size,
            timeoutMs: 600_000,
            traffic: "data",
          });
          if (typeof result.size !== "number" || typeof result.md5 !== "string")
            throw new Error("网盘回读校验结果无效");
          return { size: result.size, md5: result.md5 };
        },
      });
    let verifyFile = createVerifier();
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
        directories.invalidate(destination);
      }
      parent = destination;
    }
    options.onProgress?.("校验本地文件并选择可复用的网盘目录");
    const planStartedAt = Date.now();
    const plan = await planUploadDirectory({ ...options, list, verifyFile });
    options.onProgress?.(
      `上传阶段统计：本地及远端预检 ${plan.identities.size} 个文件，耗时 ${((Date.now() - planStartedAt) / 1000).toFixed(1)} 秒`,
    );
    const remoteDirectory = plan.remoteDirectory;
    await options.onRemoteDirectorySelected?.(remoteDirectory);
    const legacyPaths = new Set(plan.legacyDirectories.map((entry) => entry.path));
    const deleteEntries = async (entries: RemoteUploadEntry[]) => {
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        if (
          entry.path !== remoteDirectory &&
          !entry.path.startsWith(remoteDirectory + "/") &&
          !legacyPaths.has(entry.path)
        )
          throw new Error("拒绝清理当前二创版本范围以外的网盘文件");
        const current = (await list(path.posix.dirname(entry.path), true)).find(
          (file) => file.path === entry.path,
        );
        if (!current) continue;
        if (!entry.fs_id || String(current.fs_id) !== String(entry.fs_id))
          throw new Error(`网盘文件已变化，停止清理：${entry.path}`);
        options.onProgress?.(`清理重复或冲突内容：${path.posix.basename(entry.path)}`);
        await api(
          "/api/filemanager",
          { filelist: JSON.stringify([entry.path]) },
          { opera: "delete", async: "2", onnest: "fail" },
          `删除网盘文件：${entry.path}`,
        );
        directories.invalidate(entry.path);
        let missing = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          if (
            !(await list(path.posix.dirname(entry.path), true)).some(
              (file) => file.path === entry.path,
            )
          ) {
            missing = true;
            break;
          }
          await delay(Math.min(500 * 2 ** attempt, 5_000), undefined, { signal: options.signal });
        }
        if (!missing) throw new Error(`网盘尚未确认清理完成，请稍后重试：${entry.path}`);
      }
    };
    if (plan.reuseFrom) {
      if (plan.existing) await deleteEntries([plan.existing]);
      options.onProgress?.("复用已上传内容，恢复固定版本目录名");
      const current = (await list(parent, true)).find((file) => file.path === plan.reuseFrom!.path);
      if (!current || String(current.fs_id) !== String(plan.reuseFrom.fs_id))
        throw new Error("待复用的网盘版本目录已变化，请重试");
      await api(
        "/api/filemanager",
        {
          filelist: JSON.stringify([
            { path: plan.reuseFrom.path, newname: path.posix.basename(remoteDirectory) },
          ]),
        },
        { opera: "rename", async: "2", onnest: "fail" },
        `重命名网盘目录：${plan.reuseFrom.path}`,
      );
      directories.invalidate(plan.reuseFrom.path);
      directories.invalidate(remoteDirectory);
      let renamed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const entries = await list(parent, true);
        if (
          !entries.some((entry) => entry.path === plan.reuseFrom!.path) &&
          entries.some(
            (entry) =>
              entry.path === remoteDirectory &&
              String(entry.fs_id) === String(plan.reuseFrom!.fs_id),
          )
        ) {
          renamed = true;
          break;
        }
        await delay(Math.min(500 * 2 ** attempt, 5_000), undefined, { signal: options.signal });
      }
      if (!renamed) throw new Error("网盘尚未确认版本目录重命名完成，请稍后重试");
      verifyFile.relocate(plan.reuseFrom.path, remoteDirectory);
    }
    await deleteEntries(plan.conflicts);
    const existingDirectory = (await list(parent)).find((file) => file.path === remoteDirectory);
    const directory =
      existingDirectory ??
      (await api(
        "/api/create",
        { path: remoteDirectory, isdir: "1", block_list: "[]" },
        { a: "commit" },
      ));
    if (!existingDirectory) directories.invalidate(remoteDirectory);
    const directoryId = Number(directory.fs_id);
    let nodeWarmup: Promise<void> | undefined;
    const uploadFile = async (local: string, destination: string, fileSignal: AbortSignal) => {
      fileSignal.throwIfAborted();
      const info = await stat(local);
      if (!info.size) throw new Error(`素材文件为空：${local}`);
      options.onProgress?.(`上传 ${path.basename(local)}`);
      let transferredBytes = 0,
        transferDurationMs = 0;
      let verificationStartedAt = Date.now();
      const reportReady = () => {
        const transfer = transferredBytes
          ? `传输 ${(transferredBytes / 1024 / 1024).toFixed(1)} MiB，${(transferDurationMs / 1000).toFixed(1)} 秒，${(transferredBytes / 1024 / 1024 / Math.max(transferDurationMs / 1000, 0.001)).toFixed(1)} MiB/s`
          : "复用已有内容";
        options.onProgress?.(
          `上传阶段统计：${path.basename(local)}；${transfer}；合并及校验 ${((Date.now() - verificationStartedAt) / 1000).toFixed(1)} 秒`,
        );
      };
      {
        const blockSize = uploadBlockSize;
        const identity = plan.identities.get(local);
        if (!identity || identity.size !== info.size || identity.modifiedAtMs !== info.mtimeMs)
          throw new Error(`素材文件在上传前发生变化：${local}`);
        const hashes = identity.hashes;
        const siblings = await list(path.posix.dirname(destination));
        const existing = siblings.find((file) => file.path === destination);
        if (existing) {
          if (await verifyFile(existing, identity, fileSignal)) {
            reportReady();
            return;
          }
          throw new Error(`网盘文件在预检后发生变化，请重试以清理冲突内容：${destination}`);
        }
        const pre = await api(
          "/api/precreate",
          {
            path: destination,
            target_path: path.posix.dirname(destination),
            size: String(info.size),
            isdir: "0",
            autoinit: "1",
            block_list: JSON.stringify(hashes),
          },
          {},
          undefined,
          fileSignal,
        );
        let committedEntry: RemoteVerificationEntry | undefined;
        if (pre.return_type !== 2) {
          if (typeof pre.uploadid !== "string" || !pre.uploadid || !Array.isArray(pre.block_list))
            throw new Error("百度网盘未返回有效上传会话");
          const uploadId = pre.uploadid;
          const indexes = pre.block_list as number[];
          if (
            indexes.some(
              (index) => !Number.isInteger(index) || index < 0 || index >= hashes.length,
            ) ||
            new Set(indexes).size !== indexes.length
          )
            throw new Error("百度网盘返回无效分片序号");
          let finishedParts = 0;
          const transferStartedAt = Date.now();
          await uploadBaiduParts(
            indexes,
            async (index, partSignal) => {
              partSignal.throwIfAborted();
              const boundary = `dramabridge${randomBytes(12).toString("hex")}`;
              const params = new URLSearchParams({
                method: "upload",
                app_id: "250528",
                channel: "chunlei",
                web: "1",
                clienttype: "0",
                path: destination,
                uploadid: uploadId,
                uploadsign:
                  typeof pre.uploadsign === "string" || typeof pre.uploadsign === "number"
                    ? String(pre.uploadsign)
                    : "0",
                partseq: String(index),
              });
              const progress = `上传 ${path.basename(local)} 分片 ${index + 1}/${hashes.length}`;
              const sendPart = async () => {
                let uploaded: Awaited<ReturnType<typeof clientUploadRequest>> | undefined;
                const servers = await locateUpload(partSignal);
                for (let serverIndex = 0; serverIndex < servers.length; serverIndex++) {
                  partSignal.throwIfAborted();
                  try {
                    uploaded = await clientUploadRequest(
                      page,
                      `${servers[serverIndex]}/rest/2.0/pcs/superfile2?${params}`,
                      undefined,
                      undefined,
                      {
                        signal: partSignal,
                        label: progress,
                        onRetry: options.onProgress,
                        timeoutMs: 600_000,
                        retryable: true,
                        traffic: "data",
                        filePart: {
                          path: local,
                          offset: index * blockSize,
                          length: Math.min(blockSize, info.size - index * blockSize),
                          size: info.size,
                          modifiedAtMs: identity.modifiedAtMs,
                          md5: hashes[index],
                          boundary,
                        },
                      },
                    );
                    if (serverIndex > 0)
                      uploadServers = [
                        servers[serverIndex],
                        ...servers.filter((server) => server !== servers[serverIndex]),
                      ];
                    break;
                  } catch (error) {
                    if (!isBaiduUploadTransportError(error) || serverIndex === servers.length - 1)
                      throw error;
                    options.onProgress?.(
                      `${progress}：切换备用上传节点（${serverIndex + 2}/${servers.length}）`,
                    );
                  }
                }
                if (!uploaded) throw new Error("没有可用的百度网盘上传节点");
                if (normalizeBaiduMd5(uploaded.md5) !== hashes[index])
                  throw new Error(`上传分片校验失败：${destination} #${index}`);
              };
              // Warm the shared node once per task, not once per file. Other
              // files/parts wait on the same first transfer before filling lanes.
              if (!nodeWarmup) {
                nodeWarmup = sendPart();
                await nodeWarmup;
              } else {
                await nodeWarmup;
                partSignal.throwIfAborted();
                await sendPart();
              }
              finishedParts++;
              transferredBytes += Math.min(blockSize, info.size - index * blockSize);
              options.onProgress?.(
                `上传 ${path.basename(local)}：已完成 ${finishedParts}/${indexes.length} 个待传分片`,
              );
            },
            fileSignal,
            { warmup: false },
          );
          transferDurationMs = Date.now() - transferStartedAt;
          verificationStartedAt = Date.now();
          options.onProgress?.(`合并上传分片：${path.basename(local)}`);
          try {
            const committed = await api(
              "/api/create",
              {
                path: destination,
                target_path: path.posix.dirname(destination),
                size: String(info.size),
                isdir: "0",
                uploadid: pre.uploadid,
                block_list: JSON.stringify(hashes),
                ...(typeof pre.uploadsign === "string" || typeof pre.uploadsign === "number"
                  ? { uploadsign: String(pre.uploadsign) }
                  : {}),
              },
              { a: "commit" },
              undefined,
              fileSignal,
            );
            // A complete commit response is already authoritative metadata.
            // Reuse it; only request filemetas when fields/dlink are missing.
            if (
              committed.path === destination &&
              Number(committed.isdir) === 0 &&
              Number(committed.size) === info.size &&
              (typeof committed.fs_id === "number" || typeof committed.fs_id === "string")
            ) {
              committedEntry = {
                path: destination,
                server_filename: path.posix.basename(destination),
                isdir: 0,
                size: info.size,
                fs_id: committed.fs_id,
                md5: normalizeBaiduMd5(committed.md5),
                server_mtime:
                  typeof committed.server_mtime === "number" ? committed.server_mtime : undefined,
              };
            }
          } catch (error) {
            // A transport failure can happen after the server committed the file.
            // Reconcile once; never replay a potentially successful mutation.
            if (!isBaiduUploadTransportError(error)) throw error;
            const committed = await metadata(destination, fileSignal).catch((inspectionError) => {
              if (
                /BAIDU_NETDISK_(?:RISK_CONTROL|IDENTITY_VERIFICATION)/.test(String(inspectionError))
              )
                throw inspectionError;
              return undefined;
            });
            if (!committed || !(await verifyFile(committed, identity, fileSignal))) throw error;
            await directories.remember(committed);
            options.onProgress?.(`已确认合并请求实际成功：${path.basename(local)}`);
            reportReady();
            return;
          }
        }
        // File metadata confirms the commit without re-enumerating the whole directory per file.
        options.onProgress?.(`校验已上传文件：${path.basename(local)}`);
        let verified = committedEntry ?? (await metadata(destination, fileSignal));
        for (let attempt = 0; !verified && attempt < 3; attempt++) {
          await delay(1_000 * (attempt + 1), undefined, { signal: fileSignal });
          verified = await metadata(destination, fileSignal);
        }
        if (!verified || !(await verifyFile(verified, identity, fileSignal)))
          throw new Error(`网盘文件校验失败：${destination}`);
        await directories.remember(verified);
        reportReady();
      }
    };
    const filesToUpload: Array<{ local: string; destination: string }> = [];
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
          if (!existing) {
            await api(
              "/api/create",
              { path: remote, isdir: "1", block_list: "[]" },
              { a: "commit" },
            );
            directories.invalidate(remote);
          }
          await uploadTree(path.join(local, entry.name), remote);
        } else if (entry.isFile())
          filesToUpload.push({ local: path.join(local, entry.name), destination: remote });
        else throw new Error("不支持上传符号链接素材");
      }
    };
    await uploadTree(options.localDirectory, remoteDirectory);
    if (options.reuseSource) {
      await copyBaiduVersionFiles({
        source: options.reuseSource,
        targetDirectory: remoteDirectory,
        localDirectory: options.localDirectory,
        identities: plan.identities,
        list,
        copy: (items) =>
          api(
            "/api/filemanager",
            { filelist: JSON.stringify(items) },
            { opera: "copy", async: "0", onnest: "fail", channel: "chunlei" },
            "云端复制版本文件",
          ),
        query: (taskId) => {
          const params = new URLSearchParams({
            taskid: taskId,
            bdstoken: token,
            web: "1",
            clienttype: "0",
            channel: "chunlei",
            app_id: "250528",
          });
          return clientRequest(`https://pan.baidu.com/api/taskquery?${params}`);
        },
        verify: (file, identity) => verifyFile(file, identity, options.signal),
        wait: (milliseconds) => delay(milliseconds, undefined, { signal: options.signal }),
        onVerified,
        onProgress: options.onProgress,
        signal: options.signal,
      });
      verifyFile = createVerifier();
    }
    const batchStartedAt = Date.now();
    await runUploadJobs(
      filesToUpload,
      (file, signal) => uploadFile(file.local, file.destination, signal),
      UPLOAD_FILE_CONCURRENCY,
      options.signal,
    );
    options.onProgress?.(
      `上传阶段统计：${filesToUpload.length} 个文件传输及校验完成，批次耗时 ${((Date.now() - batchStartedAt) / 1000).toFixed(1)} 秒`,
    );
    // Cached listings are only an optimization. Reconcile fresh directory contents before sharing.
    const verifiedEntries: RemoteUploadEntry[] = [];
    const verifyTree = async (local: string, remote: string): Promise<void> => {
      options.signal?.throwIfAborted();
      const localEntries = await readdir(local, { withFileTypes: true });
      const cloud = await list(remote, true);
      if (cloud.length !== localEntries.length)
        throw new Error(`上传后目录内容不一致，已停止分享：${remote}`);
      for (const entry of localEntries) {
        const file = cloud.find((file) => file.path === path.posix.join(remote, entry.name));
        if (!file || Boolean(file.isdir) !== entry.isDirectory())
          throw new Error(`上传后缺少文件或类型不符：${remote}/${entry.name}`);
        const source = path.join(local, entry.name);
        if (entry.isDirectory()) await verifyTree(source, file.path);
        else {
          const identity = plan.identities.get(source);
          const current = await stat(source);
          if (
            !identity ||
            current.size !== identity.size ||
            current.mtimeMs !== identity.modifiedAtMs ||
            !(await verifyFile(file, identity))
          )
            throw new Error(`上传后文件校验失败，已停止分享：${file.path}`);
          verifiedEntries.push(file);
        }
      }
    };
    options.onProgress?.("复核上传目录，确认全部文件");
    await verifyTree(options.localDirectory, remoteDirectory);
    if (options.createShare === false)
      return { remotePath: remoteDirectory, shareUrl: "", extractionCode: "", verifiedEntries };
    if (!directoryId) throw new Error("上传目录缺少文件 ID");
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
    // Old sibling attempts are outside the verified shared directory. Their
    // cleanup is optional and must not discard an already-created share result.
    // Required conflicts above remain blocking: never share mixed contents.
    try {
      await deleteEntries(plan.legacyDirectories);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.onProgress?.(
        `上传及分享已完成，旧目录清理未完成，已保留：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { remotePath: remoteDirectory, shareUrl, extractionCode, verifiedEntries };
  });
}
