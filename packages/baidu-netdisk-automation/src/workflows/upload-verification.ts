import { normalizeBaiduMd5 } from "../domain/file-checksum.js";
import type { RemoteUploadEntry, UploadFileIdentity } from "./upload-directory-plan.js";

export type RemoteVerifiedFile = {
  path: string; fsId: string; size: number; serverMd5: string; serverMtime: number; contentMd5: string;
};
export type RemoteVerificationEntry = RemoteUploadEntry & { fs_id?: number | string; server_mtime?: number; dlink?: string };

/** Some multipart uploads have an incorrect server MD5. Verify actual bytes before trusting them. */
export function createRemoteFileVerifier(options: {
  saved?: RemoteVerifiedFile[];
  metadata: (path: string) => Promise<RemoteVerificationEntry | undefined>;
  contentChecksum: (url: string, size: number, path: string) => Promise<{ size: number; md5: string }>;
  onVerified?: (file: RemoteVerifiedFile) => void;
}) {
  const verified = new Map(options.saved?.map(file => [file.path, file]));
  const verify = async (file: RemoteVerificationEntry, identity: UploadFileIdentity): Promise<boolean> => {
    if (file.isdir || file.size !== identity.size) return false;
    const serverMd5 = normalizeBaiduMd5(file.md5);
    if (serverMd5 === identity.md5) return true;
    const receipt = verified.get(file.path);
    if (receipt && serverMd5 && file.fs_id && file.server_mtime
      && receipt.fsId === String(file.fs_id) && receipt.serverMd5 === serverMd5
      && receipt.serverMtime === Number(file.server_mtime) && receipt.size === file.size && receipt.contentMd5 === identity.md5) return true;
    const metadata = await options.metadata(file.path);
    if (!metadata) throw new Error(`网盘未返回文件详情，暂时无法完成校验：${file.path}`);
    if (metadata.path !== file.path || metadata.isdir || metadata.size !== identity.size) return false;
    if (normalizeBaiduMd5(metadata.md5) === identity.md5) return true;
    if (!metadata.dlink) throw new Error(`网盘未返回内容校验链接：${file.path}`);
    const url = new URL(metadata.dlink);
    if (url.protocol !== "https:" || !/(^|\.)(baidu\.com|baidupcs\.com)$/.test(url.hostname))
      throw new Error("网盘返回的内容校验链接无效");
    const actual = await options.contentChecksum(metadata.dlink, identity.size, file.path);
    if (actual.size !== identity.size || actual.md5 !== identity.md5) return false;
    const saved: RemoteVerifiedFile = {
      path: file.path, fsId: String(metadata.fs_id || ""), size: actual.size,
      serverMd5: normalizeBaiduMd5(metadata.md5) || "", serverMtime: Number(metadata.server_mtime) || 0, contentMd5: actual.md5,
    };
    verified.set(file.path, saved);
    options.onVerified?.(saved);
    return true;
  };
  return Object.assign(verify, {
    relocate(from: string, to: string) {
      for (const [path, file] of [...verified]) {
        if (!path.startsWith(from + "/")) continue;
        const relocated = { ...file, path: to + path.slice(from.length) };
        verified.delete(path);
        verified.set(relocated.path, relocated);
        options.onVerified?.(relocated);
      }
    },
  });
}
