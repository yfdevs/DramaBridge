import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyzeImagesAsJson } from "@dramabridge/ai";
import {
  evaluateCommercialPosterTextValidation,
  listLocalPosterImages,
  prepareImageForUpload,
} from "@dramabridge/media-assets";
import { z } from "zod";

import {
  getQqDramaLocalEpisodeVideoRoot,
  getQqDramaOriginalTitle,
} from "./local-episode-videos.js";
import { log } from "./logger.js";
import type { ClaimedQqDramaTask, QqDramaRuntimeOptions } from "./types.js";

const maximumFileBytes = 5_000_000;
const promptVersion = "qq-second-version-cover-v1";

const generatedCoverValidationSchema = z.object({
  mainSubjectsComplete: z.boolean(),
  facesIntact: z.boolean(),
  titlePresent: z.boolean(),
  titleReadable: z.boolean(),
  titleSeverelyIncorrect: z.boolean(),
  hasProhibitedOverlay: z.boolean(),
  hasClearlyUnrelatedOrGibberishText: z.boolean(),
  referenceSimilarityConfidence: z.coerce.number().finite().min(0).max(1),
  detectedTexts: z.array(z.string().trim().max(100)).max(30).default([]),
  blockingIssues: z.array(z.string().trim().max(300)).max(20).default([]),
  warnings: z.array(z.string().trim().max(300)).max(20).default([]),
});

async function selectPosterSource(
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  const localEpisodeVideoRoot = getQqDramaLocalEpisodeVideoRoot(options);
  const resourceName = getQqDramaOriginalTitle(task);
  const files = await listLocalPosterImages({
    root: localEpisodeVideoRoot,
    resourceName,
  });
  if (files.length < 1) {
    throw new Error(
      `[poster-material-invalid] 未找到文件名或目录名包含“封面”或“海报”的图片；` +
      `扫描目录=${localEpisodeVideoRoot}`,
    );
  }
  return files[0];
}

async function preparePrimaryPoster(
  source: Awaited<ReturnType<typeof selectPosterSource>>,
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  if (source.size <= maximumFileBytes) {
    task.playlet.localCoverFile = source.file;
    return source;
  }

  if (!options.assetDownloadDir) {
    throw new Error("QQ drama assetDownloadDir is required to compress the cover image.");
  }
  const outputDir = path.join(options.assetDownloadDir, "poster-upload", "primary");
  await rm(outputDir, { recursive: true, force: true });
  const prepared = await prepareImageForUpload({
    inputFile: source.file,
    outputDir,
    outputFileName: "qq-cover.jpg",
    policy: {
      maxFileBytes: maximumFileBytes,
      targetFileBytes: 4_700_000,
      minimumWidth: 1,
      minimumHeight: 1,
      minimumJpegQuality: 80,
    },
    onLog: (message) => log(options, `[qq-drama] ${message}`),
  });
  task.playlet.localCoverFile = prepared.file;
  return {
    ...source,
    file: prepared.file,
    size: prepared.outputSize,
  };
}

function secondVersionPrompt(title: string) {
  return [
    "参考原剧封面，重新设计一张同一部作品的商业漫剧封面。",
    "保留核心人物、面部特征、服饰、时代背景、人物关系、画面比例和作品辨识度，但使用不同的构图与视觉排版，不能只替换文字。",
    `新剧名必须完整、清晰、逐字准确地展示为“${title}”，不改字、不漏字。`,
    "除新剧名外，不得出现其他作品名、随机乱码、联系方式、账号、二维码、平台水印、技术参数、操作按钮或伪界面元素。",
    "主要人物、面部、头部和关键道具必须完整，四周保留安全裁切空间。",
    "直接输出可发布的成品封面，不要输出设计稿、模板、制作说明或界面预览。",
  ].join("\n");
}

async function validateSecondVersionCover(
  sourceFile: string,
  generatedFile: string,
  title: string,
  options: QqDramaRuntimeOptions,
) {
  const client = options.aiClientFactory?.();
  if (!client) throw new Error("DRAMA_AI_API_KEY_REQUIRED");
  const completion = await analyzeImagesAsJson(client, {
    images: [
      { type: "file", path: sourceFile, detail: "high" },
      { type: "file", path: generatedFile, detail: "high" },
    ],
    prompt: [
      "你是 QQ 漫剧封面质检员。第 1 张是参考封面，第 2 张是待验收的新版本封面。",
      `准确的新剧名是：${title}。`,
      "检查第 2 张图：人物和人脸是否完整；是否保持原作品辨识度；剧名是否完整、清晰、没有严重错字；是否出现其他作品名、乱码、联系方式、二维码、水印、技术参数或伪界面元素。",
      "只返回 JSON 对象，不要 Markdown 或解释。格式：" + JSON.stringify({
        mainSubjectsComplete: true,
        facesIntact: true,
        titlePresent: true,
        titleReadable: true,
        titleSeverelyIncorrect: false,
        hasProhibitedOverlay: false,
        hasClearlyUnrelatedOrGibberishText: false,
        referenceSimilarityConfidence: 0.95,
        detectedTexts: [title],
        blockingIssues: [],
        warnings: [],
      }),
    ].join("\n"),
    systemPrompt: "你只输出符合用户指定结构的 JSON 对象。",
    maxTokens: 700,
    temperature: 0,
  });
  const validation = generatedCoverValidationSchema.parse(completion.data);
  const textValidation = evaluateCommercialPosterTextValidation(title, validation);
  const failures = [
    ...(!validation.mainSubjectsComplete ? ["主要人物不完整"] : []),
    ...(!validation.facesIntact ? ["人物面部异常"] : []),
    ...(validation.referenceSimilarityConfidence < 0.75 ? ["与原封面作品辨识度不足"] : []),
    ...textValidation.failures,
  ];
  return { failures, warnings: [...validation.warnings, ...textValidation.warnings] };
}

async function generateSecondVersionPoster(
  sourceFile: string,
  title: string,
  options: QqDramaRuntimeOptions,
) {
  if (!options.assetDownloadDir) {
    throw new Error("QQ drama assetDownloadDir is required to generate the second cover image.");
  }
  const client = options.aiClientFactory?.();
  if (!client) throw new Error("DRAMA_AI_API_KEY_REQUIRED");
  const model = options.aiImageModel?.trim();
  if (!model) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");
  const prompt = secondVersionPrompt(title);
  const cacheKey = createHash("sha256")
    .update(await readFile(sourceFile))
    .update(model)
    .update(promptVersion)
    .update(prompt)
    .digest("hex")
    .slice(0, 24);
  const outputDir = path.join(options.assetDownloadDir, "poster-upload", "secondary", cacheKey);
  const jpegOutput = path.join(outputDir, "qq-second-version-cover.jpg");
  const metadataOutput = path.join(outputDir, "generation.json");
  if (
    await access(jpegOutput).then(() => true, () => false) &&
    await access(metadataOutput).then(() => true, () => false)
  ) {
    log(options, `[qq-drama] reused AI second-version cover cache: ${jpegOutput}`);
    return jpegOutput;
  }
  await mkdir(outputDir, { recursive: true });

  const attempts = Math.max(
    1,
    Math.min(11, Math.floor(options.aiCoverGenerationRetryAttempts ?? 3) + 1),
  );
  let lastError: unknown;
  let previousFailure = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rawOutput = path.join(outputDir, `.generated-${process.pid}-${Date.now()}-${attempt}.image`);
    try {
      const retryGuidance = previousFailure
        ? `\n\n上一张未通过验收：${previousFailure.slice(0, 500)}。请重新生成并逐项修正。`
        : "";
      log(options, "[qq-drama] generating AI second-version cover", {
        title,
        attempt,
        attempts,
        model,
      });
      const result = await client.generateImage({
        model,
        prompt: prompt + retryGuidance,
        referenceImages: [{ type: "file", path: sourceFile }],
        size: "1440x2560",
        watermark: false,
      });
      const generated = result.images[0];
      if (!generated?.data.length) throw new Error("QQ_DRAMA_AI_COVER_RESPONSE_MISSING");
      await writeFile(rawOutput, Buffer.from(generated.data));
      const prepared = await prepareImageForUpload({
        inputFile: rawOutput,
        outputDir,
        outputFileName: path.basename(jpegOutput),
        policy: {
          maxFileBytes: maximumFileBytes,
          targetFileBytes: 4_700_000,
          minimumWidth: 1,
          minimumHeight: 1,
          minimumJpegQuality: 80,
        },
        onLog: (message) => log(options, `[qq-drama] ${message}`),
      });
      const output = prepared.file;
      const validation = await validateSecondVersionCover(sourceFile, output, title, options);
      if (validation.failures.length > 0) {
        previousFailure = validation.failures.join("；");
        await rm(output, { force: true });
        throw new Error(`QQ_DRAMA_AI_COVER_VALIDATION_FAILED: ${previousFailure}`);
      }
      if (validation.warnings.length > 0) {
        log(options, "[qq-drama] AI second-version cover validation warnings", {
          warnings: validation.warnings,
        });
      }
      await writeFile(metadataOutput, JSON.stringify({
        cacheKey,
        promptVersion,
        title,
        model: result.model,
        requestId: result.requestId,
        sourceFile,
        output,
        createdAt: new Date().toISOString(),
      }, null, 2));
      log(options, `[qq-drama] AI second-version cover ready: ${output}`);
      return output;
    } catch (error) {
      lastError = error;
      await rm(metadataOutput, { force: true }).catch(() => undefined);
      log(options, "[qq-drama] AI second-version cover attempt failed", {
        title,
        attempt,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await rm(rawOutput, { force: true }).catch(() => undefined);
    }
  }
  throw Object.assign(new Error("QQ_DRAMA_AI_COVER_GENERATION_FAILED"), {
    cause: lastError,
  });
}

export async function prepareQqDramaPosterMaterial(
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  const source = await selectPosterSource(task, options);
  return preparePrimaryPoster(source, task, options);
}

export async function prepareQqDramaPosterMaterials(
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  const source = await selectPosterSource(task, options);
  const primary = await preparePrimaryPoster(source, task, options);
  const secondary = options.acceptSecondVersion !== false && task.playlet.secondVersionEnabled
    ? await generateSecondVersionPoster(
        source.file,
        task.playlet.secondVersionTitle!,
        options,
      )
    : undefined;
  return { primary: primary.file, secondary };
}
