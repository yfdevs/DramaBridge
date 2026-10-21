import { safeFileName } from "@dramabridge/file-utils";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_BAIDU_NETDISK_SHARE_NAME } from "./constants.js";
import type { BaiduNetdiskShareInfo } from "./types.js";

function trimShareLink(value: string) {
  return value.replace(/[),，。；;、\]]+$/g, "");
}

export function sanitizeWindowsName(value: string) {
  return safeFileName(value, {
    fallback: DEFAULT_BAIDU_NETDISK_SHARE_NAME,
    replacement: "_",
  });
}

export function parseBaiduNetdiskShareText(
  content: string,
  sourceLabel = "分享文本",
): BaiduNetdiskShareInfo {
  const link = trimShareLink(content.match(/https?:\/\/pan\.baidu\.com\/s\/[^\s"'<>]+/)?.[0] ?? "");
  if (!link) throw new Error(`${sourceLabel} 中没有找到百度网盘分享链接。`);

  const url = new URL(link);
  const pwd =
    url.searchParams.get("pwd") ??
    content.match(/(?:提取码|密码|pwd)[:：\s]*([a-zA-Z0-9]{4})/)?.[1];
  if (!pwd) throw new Error(`${sourceLabel} 中没有找到提取码。`);

  const name =
    content.match(/通过网盘分享的文件[:：]\s*([^\r\n]+)/)?.[1]?.trim() ??
    content.match(/分享的文件[:：]\s*([^\r\n]+)/)?.[1]?.trim() ??
    DEFAULT_BAIDU_NETDISK_SHARE_NAME;

  return { link, pwd, name: sanitizeWindowsName(name) };
}

export async function readShareInfo(shareFile: string) {
  const fullPath = path.resolve(process.cwd(), shareFile);
  const content = await readFile(fullPath, "utf8");
  return {
    content,
    share: parseBaiduNetdiskShareText(content, shareFile),
  };
}
