import { createHash } from "node:crypto";
import { safeFileName } from "@dramabridge/file-utils";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QqDramaRuntimeOptions } from "../shared/types.js";

function extensionFromContentType(contentType: string | null) {
  if (!contentType) return "";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("pdf")) return ".pdf";
  if (contentType.includes("mp4")) return ".mp4";
  return "";
}

export async function downloadRemoteAsset(
  url: string,
  options: QqDramaRuntimeOptions,
  fallbackFileName: string,
) {
  if (!options.assetDownloadDir) {
    throw new Error("QQ drama assetDownloadDir is required to download remote assets.");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download asset: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type");
  const sourceName = path.basename(new URL(url).pathname);
  const sourceExtension = path.extname(sourceName);
  const extension = sourceExtension || extensionFromContentType(contentType);
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 10);
  const fileName = `${safeFileName(path.basename(sourceName, sourceExtension) || fallbackFileName, {
    fallback: "asset",
    maxLength: 160,
    replacement: "_",
  })}-${digest}${extension}`;
  const filePath = path.join(options.assetDownloadDir, fileName);

  await mkdir(options.assetDownloadDir, { recursive: true });
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return filePath;
}
