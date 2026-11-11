import path from "node:path";
import { normalizeBaiduMd5 } from "../domain/file-checksum.js";
import { baiduApiError } from "../infrastructure/request-policy.js";
import {
  assertRecreationVersionDirectory,
  type UploadFileIdentity,
} from "./upload-directory-plan.js";
import type { RemoteVerifiedFile, RemoteVerificationEntry } from "./upload-verification.js";

export type BaiduVersionReuseSource = {
  remoteDirectory: string;
  verifiedFiles?: RemoteVerifiedFile[];
};
export type BaiduCopyItem = { path: string; dest: string; newname: string };

export function validateBaiduVersionReuse(source: string, target: string) {
  assertRecreationVersionDirectory(source);
  assertRecreationVersionDirectory(target);
  if (source === target || path.posix.dirname(source) !== path.posix.dirname(target))
    throw new Error("云端复用必须来自同一剧目的其他版本目录");
}

/** Tasks may report errno=0 while individual entries failed. */
export function assertBaiduCopyResult(result: Record<string, unknown>) {
  const failureCode = (entry: Record<string, unknown>) =>
    [entry.errno, entry.error_code, entry.task_errno]
      .map((value) => Number(value ?? 0))
      .find((code) => code !== 0) ?? 0;
  const code = failureCode(result);
  const entries = [result.info, result.list].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const failed = entries.find(
    (entry) => entry && typeof entry === "object" && failureCode(entry) !== 0,
  );
  if (code || failed || result.status === "failed") {
    const error = baiduApiError(
      { errno: code || (failed ? failureCode(failed) : 0) },
      "/api/filemanager",
    );
    throw error ?? new Error("百度网盘云端复制任务失败（status=failed）；请核对目标目录后重试");
  }
}

function isVerificationError(error: unknown) {
  return /BAIDU_NETDISK_(?:RISK_CONTROL|IDENTITY_VERIFICATION)|errno=-6\b|登录/.test(String(error));
}

function trustedContent(file: RemoteVerificationEntry, receipts: Map<string, RemoteVerifiedFile>) {
  const md5 = normalizeBaiduMd5(file.md5);
  const receipt = receipts.get(file.path);
  if (
    receipt &&
    md5 &&
    file.fs_id &&
    file.server_mtime &&
    receipt.fsId === String(file.fs_id) &&
    receipt.size === file.size &&
    receipt.serverMtime === Number(file.server_mtime) &&
    receipt.serverMd5 === md5
  )
    return receipt.contentMd5;
  return md5;
}

/** Same-content files are copied directly into their final names. All network
 * mutations use fixed destinations and onnest=fail; uncertain writes are only
 * reconciled, never immediately replayed or replaced by an upload.
 */
export async function copyBaiduVersionFiles(options: {
  source: BaiduVersionReuseSource;
  targetDirectory: string;
  localDirectory: string;
  identities: Map<string, UploadFileIdentity>;
  list: (directory: string, refresh?: boolean) => Promise<RemoteVerificationEntry[]>;
  copy: (items: BaiduCopyItem[]) => Promise<Record<string, unknown>>;
  query: (taskId: string) => Promise<Record<string, unknown>>;
  verify: (file: RemoteVerificationEntry, identity: UploadFileIdentity) => Promise<boolean>;
  wait: (milliseconds: number) => Promise<unknown>;
  onVerified?: (file: RemoteVerifiedFile) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<RemoteVerifiedFile[]> {
  validateBaiduVersionReuse(options.source.remoteDirectory, options.targetDirectory);
  options.signal?.throwIfAborted();
  const receipts = new Map(options.source.verifiedFiles?.map((file) => [file.path, file]));
  const sources: RemoteVerificationEntry[] = [];
  let directoriesRead = 0;
  const walk = async (directory: string, depth = 0): Promise<void> => {
    options.signal?.throwIfAborted();
    if (depth > 8 || ++directoriesRead > 100) throw new Error("云端源版本目录超出安全扫描范围");
    for (const file of await options.list(directory, true)) {
      if (
        file.path !== path.posix.join(directory, file.server_filename) ||
        /[\\/]/.test(file.server_filename) ||
        file.server_filename === "." ||
        file.server_filename === ".."
      )
        throw new Error("云端源版本返回了越界路径");
      if (file.isdir) await walk(file.path, depth + 1);
      else sources.push(file);
    }
  };
  try {
    await walk(options.source.remoteDirectory);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isVerificationError(error)) throw error;
    options.onProgress?.("源版本暂不可读取，当前版本按常规上传处理");
    return [];
  }
  const key = (relative: string, size: number, md5: string) =>
    `${path.posix.dirname(relative)}|${size}|${md5}`;
  const byContent = new Map<string, RemoteVerificationEntry>();
  for (const source of sources) {
    const content = trustedContent(source, receipts);
    if (content && source.fs_id && source.size > 0)
      byContent.set(
        key(path.posix.relative(options.source.remoteDirectory, source.path), source.size, content),
        source,
      );
  }
  const planned: Array<{
    source: RemoteVerificationEntry;
    destination: string;
    identity: UploadFileIdentity;
  }> = [];
  for (const [local, identity] of options.identities) {
    options.signal?.throwIfAborted();
    const relative = path.relative(options.localDirectory, local).replace(/\\/g, "/");
    if (
      !relative ||
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      relative.split("/").some((part) => part === ".." || part === ".")
    )
      throw new Error("本地版本文件路径越界");
    const destination = path.posix.join(options.targetDirectory, relative);
    const existing = (await options.list(path.posix.dirname(destination))).find(
      (file) => file.path === destination,
    );
    if (existing) {
      if (!(await options.verify(existing, identity)))
        throw new Error(`目标文件发生变化，已停止云端复制：${destination}`);
      continue;
    }
    const source = byContent.get(key(relative, identity.size, identity.md5));
    if (source) planned.push({ source, destination, identity });
  }
  const verified: RemoteVerifiedFile[] = [];
  if (!planned.length) return verified;
  options.onProgress?.(
    `从已完成版本云端复制并改名：${planned.length} 个相同内容文件；差异文件另行上传`,
  );
  for (let offset = 0; offset < planned.length; offset += 50) {
    options.signal?.throwIfAborted();
    const batch = planned.slice(offset, offset + 50);
    let submissionError: unknown;
    let taskWasReturned = false;
    try {
      const result = await options.copy(
        batch.map((item) => ({
          path: item.source.path,
          dest: path.posix.dirname(item.destination),
          newname: path.posix.basename(item.destination),
        })),
      );
      const taskId = result.taskid ?? result.task_id;
      taskWasReturned = taskId !== undefined && taskId !== null && Boolean(String(taskId));
      assertBaiduCopyResult(result);
      if (taskWasReturned) {
        let completed = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          options.signal?.throwIfAborted();
          const state = await options.query(String(taskId));
          assertBaiduCopyResult(state);
          if (state.status === "success") {
            completed = true;
            break;
          }
          await options.wait(Math.min(500 * (attempt + 1), 2000));
        }
        if (!completed) throw new Error("云端复制任务尚未确认结束，请稍后重试以核对结果");
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isVerificationError(error)) throw error;
      if (taskWasReturned) throw error;
      submissionError = error;
    }
    const pending = new Map(batch.map((item) => [item.destination, item]));
    for (let attempt = 0; pending.size && attempt < 20; attempt++) {
      options.signal?.throwIfAborted();
      const targetLists = new Map<string, RemoteVerificationEntry[]>();
      const sourceLists = new Map<string, RemoteVerificationEntry[]>();
      for (const item of pending.values()) {
        const parent = path.posix.dirname(item.destination);
        if (!targetLists.has(parent)) targetLists.set(parent, await options.list(parent, true));
      }
      for (const [destination, item] of pending) {
        const target = targetLists
          .get(path.posix.dirname(destination))!
          .find((file) => file.path === destination);
        if (!target) continue;
        if (target.isdir || target.size !== item.identity.size)
          throw new Error(`云端复制文件内容不符：${destination}`);
        const sourceParent = path.posix.dirname(item.source.path);
        if (!sourceLists.has(sourceParent))
          sourceLists.set(sourceParent, await options.list(sourceParent, true));
        const currentSource = sourceLists
          .get(sourceParent)!
          .find((file) => file.path === item.source.path);
        const sourceMd5 = normalizeBaiduMd5(item.source.md5),
          targetMd5 = normalizeBaiduMd5(target.md5);
        const sourceUnchanged =
          currentSource &&
          String(currentSource.fs_id) === String(item.source.fs_id) &&
          currentSource.size === item.source.size &&
          Number(currentSource.server_mtime) === Number(item.source.server_mtime) &&
          normalizeBaiduMd5(currentSource.md5) === sourceMd5;
        if (
          sourceUnchanged &&
          sourceMd5 &&
          targetMd5 === sourceMd5 &&
          target.fs_id &&
          target.server_mtime
        ) {
          const receipt = {
            path: destination,
            fsId: String(target.fs_id),
            size: target.size,
            serverMd5: targetMd5,
            serverMtime: Number(target.server_mtime),
            contentMd5: item.identity.md5,
          };
          verified.push(receipt);
          options.onVerified?.(receipt);
        } else if (!(await options.verify(target, item.identity)))
          throw new Error(`云端复制文件校验失败：${destination}`);
        pending.delete(destination);
      }
      if (pending.size) await options.wait(Math.min(500 * (attempt + 1), 2000));
    }
    if (pending.size) {
      const reason =
        submissionError instanceof Error ? submissionError.message : "目标文件尚未完整出现";
      throw new Error(
        `云端复制结果尚未确认，已保留目录，请稍后重试：${pending.size} 个文件；${reason}`,
      );
    }
  }
  options.onProgress?.(`云端复制及内容核对完成：${planned.length} 个文件，无需重新传输这些文件`);
  return verified;
}
