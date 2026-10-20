import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AiImageInput } from "./types.js";

const mimeTypesByExtension: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function assertHttpUrl(value: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`DRAMA_AI_IMAGE_URL_INVALID: ${value}`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`DRAMA_AI_IMAGE_URL_PROTOCOL_UNSUPPORTED: ${parsedUrl.protocol}`);
  }

  return parsedUrl.toString();
}

function assertDataUrl(value: string): string {
  if (!/^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(value)) {
    throw new Error("DRAMA_AI_IMAGE_DATA_URL_INVALID");
  }
  return value;
}

function resolveMimeType(filePath: string, explicitMimeType?: string): string {
  const mimeType = explicitMimeType?.trim().toLowerCase();
  if (mimeType) {
    if (!mimeType.startsWith("image/")) {
      throw new Error(`DRAMA_AI_IMAGE_MIME_TYPE_INVALID: ${mimeType}`);
    }
    return mimeType;
  }

  const inferredMimeType = mimeTypesByExtension[path.extname(filePath).toLowerCase()];
  if (!inferredMimeType) {
    throw new Error(`DRAMA_AI_IMAGE_MIME_TYPE_REQUIRED: ${filePath}`);
  }
  return inferredMimeType;
}

export async function resolveImageDataUrl(input: AiImageInput): Promise<string> {
  if (input.type === "url") return assertHttpUrl(input.url.trim());
  if (input.type === "data-url") return assertDataUrl(input.dataUrl.trim());

  const filePath = input.path.trim();
  if (!filePath) throw new Error("DRAMA_AI_IMAGE_FILE_PATH_REQUIRED");

  const mimeType = resolveMimeType(filePath, input.mimeType);
  const content = await readFile(filePath);
  return `data:${mimeType};base64,${content.toString("base64")}`;
}
