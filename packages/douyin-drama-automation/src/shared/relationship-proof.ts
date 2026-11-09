import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { douyinRelationshipProofBase64 } from "./relationship-proof-image.js";
import type { DouyinDramaRuntimeOptions } from "./types.js";

/** Keep the supplied image bundled so packaged apps never depend on a local source path. */
export async function appendDouyinRelationshipProof(
  files: string[],
  options: DouyinDramaRuntimeOptions,
  outputRoot: string,
) {
  const accountId = (options.douyinAccountId || options.accountProfileName)?.trim();
  if (!accountId) {
    throw new Error("DOUYIN_DRAMA_ACCOUNT_ID_REQUIRED: 无法判断是否需要关联关系证明");
  }
  if (accountId === "17732354154") return files;
  const directory = path.join(outputRoot, "relationship-proof");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "关联关系证明.png");
  await writeFile(file, Buffer.from(douyinRelationshipProofBase64, "base64"));
  return [...new Set([...files, file])];
}
