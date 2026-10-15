import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareCroppedImageVariant } from "@drama/drama-media-assets";
import { TAOBAO_DRAMA_COVER_HEIGHT, TAOBAO_DRAMA_COVER_WIDTH } from "./constants.js";
import { findTaobaoSourcePoster } from "./local-materials.js";
import { log } from "./logger.js";
import type {
  TaobaoBatchUploadTask,
  TaobaoCollectionMetadata,
  TaobaoDramaRuntimeOptions,
} from "./types.js";

const promptVersion = "taobao-local-collection-cover-v1";

async function downloadSourceCover(url: string, outputDir: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TAOBAO_DRAMA_COVER_DOWNLOAD_FAILED: status=${response.status}`);
  const file = path.join(outputDir, "source-cover");
  await mkdir(outputDir, { recursive: true });
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

export async function prepareTaobaoCollectionCover(
  task: TaobaoBatchUploadTask,
  metadata: TaobaoCollectionMetadata,
  options: TaobaoDramaRuntimeOptions,
) {
  if (!options.aiClientFactory) throw new Error("TAOBAO_DRAMA_AI_CLIENT_REQUIRED");
  if (!options.aiImageModel?.trim()) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");
  const sourceDir = path.join(options.assetDownloadDir?.trim() || os.tmpdir(), "taobao-cover-source", task.id);
  const sourceFile = task.sourceCoverFile
    ?? (task.sourceCoverUrl ? await downloadSourceCover(task.sourceCoverUrl, sourceDir) : undefined)
    ?? await findTaobaoSourcePoster(task, options);
  const source = sourceFile ? await readFile(sourceFile) : Buffer.from("text-only-cover");
  const cacheKey = createHash("sha256")
    .update(source)
    .update(options.aiImageModel)
    .update(promptVersion)
    .update(metadata.title)
    .update(metadata.summary)
    .digest("hex")
    .slice(0, 24);
  const outputDir = path.join(
    options.assetDownloadDir?.trim() || os.tmpdir(),
    "generated-covers",
    cacheKey,
  );
  const output = path.join(outputDir, "taobao-cover-1080x1800.jpg");
  if (await access(output).then(() => true, () => false)) return output;
  await mkdir(outputDir, { recursive: true });

  const attempts = Math.max(
    1,
    Math.min(11, Math.floor(options.aiCoverGenerationRetryAttempts ?? 3) + 1),
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const temporary = path.join(outputDir, `.generated-${process.pid}-${Date.now()}-${attempt}`);
    try {
      log(options, `[taobao-drama] 正在生成淘宝 3:5 合集封面：${attempt}/${attempts}`);
      const generated = await options.aiClientFactory().generateImage({
        model: options.aiImageModel,
        referenceImages: sourceFile ? [{ type: "file", path: sourceFile }] : undefined,
        size: "1080x1800",
        watermark: false,
        prompt: [
          "生成淘宝短剧合集3:5竖版商业封面，人物和核心冲突位于中央安全区，面部与手部完整。",
          sourceFile ? "参考素材中的人物、服饰、场景和美术风格重新构图。" : "根据剧名和剧情简介设计人物与场景。",
          `清晰、准确地展示中文剧名“${metadata.title}”，不得错字、漏字或使用拼音替代。`,
          "不要出现其他作品名、乱码、联系方式、账号、平台水印、二维码、边框、尺寸参数、按钮或伪界面。",
          `剧情简介：${metadata.summary}`,
        ].join("\n"),
      });
      const image = generated.images[0];
      if (!image?.data.length) throw new Error("TAOBAO_DRAMA_AI_COVER_RESPONSE_MISSING");
      await writeFile(temporary, Buffer.from(image.data));
      const prepared = await prepareCroppedImageVariant({
        inputFile: temporary,
        outputFile: output,
        width: TAOBAO_DRAMA_COVER_WIDTH,
        height: TAOBAO_DRAMA_COVER_HEIGHT,
        jpegQuality: 92,
        maxFileBytes: 9_500_000,
        onLog: (message) => log(options, `[taobao-drama] ${message}`),
      });
      return prepared.file;
    } catch (error) {
      lastError = error;
      await rm(output, { force: true }).catch(() => undefined);
      log(options, `[taobao-drama] AI 合集封面生成失败：${attempt}/${attempts} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw Object.assign(new Error("TAOBAO_DRAMA_AI_COVER_GENERATION_FAILED"), { cause: lastError });
}
