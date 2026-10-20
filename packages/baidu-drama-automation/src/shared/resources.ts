import { analyzeImagesAsJson, type DramaAiClient } from "@dramabridge/ai";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  evaluateCommercialPosterTextValidation,
  listLocalPosterImages,
  prepareCroppedImageVariant,
  readImageDimensions,
  validateLocalEpisodeVideos,
} from "@dramabridge/media-assets";
import { z } from "zod";
import { log } from "./logger.js";
import type { BaiduDramaRuntimeOptions, ClaimedBaiduDramaTask } from "./types.js";

export const BAIDU_DRAMA_LANDSCAPE_COVER_SIZE = {
  width: 1_280,
  height: 720,
} as const;

export const BAIDU_DRAMA_PORTRAIT_COVER_SIZE = {
  width: 1_200,
  height: 1_600,
} as const;

type BaiduCoverKind = "landscape" | "portrait";

const baiduAiCoverPromptVersion = "baidu-counterpart-cover-v3-commercial-copy";
const baiduAiTransientRetryAttempts = 5;
const baiduAiTransientRetryBaseDelayMs = 1_000;
const activeAiCoverGenerations = new Map<string, Promise<string>>();

const baiduAiCoverValidationSchema = z.object({
  titlePresent: z.boolean(),
  titleReadable: z.boolean(),
  titleSeverelyIncorrect: z.boolean(),
  hasProhibitedOverlay: z.boolean(),
  hasClearlyUnrelatedOrGibberishText: z.boolean(),
  detectedTexts: z.array(z.string().trim().max(100)).max(30).default([]),
  blockingIssues: z.array(z.string().trim().max(300)).max(20).default([]),
  warnings: z.array(z.string().trim().max(300)).max(20).default([]),
});

const baiduCoverDetails = {
  landscape: {
    label: "16:9 横版",
    promptLabel: "宽幅横向",
    outputName: "baidu-cover-landscape-1280x720.jpg",
    size: "2560x1440",
    target: BAIDU_DRAMA_LANDSCAPE_COVER_SIZE,
  },
  portrait: {
    label: "3:4 竖版",
    promptLabel: "纵向",
    outputName: "baidu-cover-portrait-1200x1600.jpg",
    size: "1536x2048",
    target: BAIDU_DRAMA_PORTRAIT_COVER_SIZE,
  },
} as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !visited.has(current)) {
    chain.push(current);
    visited.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return chain;
}

function isBaiduAiTransientError(error: unknown) {
  return errorChain(error).some((item) => {
    const candidate = item as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      status?: unknown;
    };
    const status = typeof candidate?.status === "number" ? candidate.status : undefined;
    if (status === 408 || status === 429 || status === 504) return true;
    const text = [candidate?.name, candidate?.code, candidate?.message]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return /(?:HTTP\s*)?(?:408|429|504)\b|too many requests|rate.?limit|timeout|timed out|abort(?:ed|error)|ETIMEDOUT|UND_ERR_(?:CONNECT_)?TIMEOUT/i.test(text);
  });
}

async function runBaiduAiWithTransientRetries<T>(options: {
  action: string;
  operation: () => Promise<T>;
  onLog?: (message: string) => void;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= baiduAiTransientRetryAttempts; attempt += 1) {
    try {
      return await options.operation();
    } catch (error) {
      lastError = error;
      if (!isBaiduAiTransientError(error) || attempt >= baiduAiTransientRetryAttempts) throw error;
      const delayMs = Math.min(
        baiduAiTransientRetryBaseDelayMs * (2 ** (attempt - 1)),
        8_000,
      );
      options.onLog?.(
        `[baidu-cover-ai] AI ${options.action}遇到超时或限流，` +
          `${attempt}/${baiduAiTransientRetryAttempts}，${delayMs / 1_000} 秒后重试：${errorMessage(error)}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function baiduDramaResourceName(task: ClaimedBaiduDramaTask) {
  return task.originalTitle.trim();
}

export function baiduDramaLocalRoot(options: BaiduDramaRuntimeOptions) {
  const root = options.localEpisodeVideoRoot?.trim();
  if (!root) throw new Error("BAIDU_DRAMA_LOCAL_VIDEO_ROOT_REQUIRED");
  return root;
}

function remoteMaterialExtension(url: URL, contentType: string | null) {
  const urlExtension = path.extname(url.pathname);
  if (urlExtension && urlExtension.length <= 10) return urlExtension;
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return ({
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  } as Record<string, string>)[type ?? ""] ?? ".bin";
}

async function prepareMaterialReferences(
  references: string[],
  category: string,
  options: BaiduDramaRuntimeOptions,
) {
  const outputDir = path.join(
    options.assetDownloadDir ?? path.resolve(process.cwd(), ".drama-runs/baidu-drama/assets"),
    "material-upload",
    category,
  );
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  return Promise.all(references.map(async (reference, index) => {
    if (!/^https?:\/\//i.test(reference)) {
      const fileStat = await stat(reference).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size <= 0) {
        throw new Error(`BAIDU_DRAMA_MATERIAL_FILE_NOT_FOUND: ${reference}`);
      }
      return reference;
    }

    const url = new URL(reference);
    const response = await fetch(reference, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`BAIDU_DRAMA_MATERIAL_DOWNLOAD_FAILED: HTTP ${response.status}: ${reference}`);
    }
    const extension = remoteMaterialExtension(url, response.headers.get("content-type"));
    const target = path.join(outputDir, `${category}-${index + 1}${extension}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    log(options, `[baidu-drama] 公共材料下载完成：字段=${category} 文件=${target}`, undefined, "resources");
    return target;
  }));
}

async function isPreparedCover(file: string, kind: BaiduCoverKind) {
  const fileStat = await stat(file).catch(() => undefined);
  if (!fileStat?.isFile() || fileStat.size <= 0) return false;
  const dimensions = await readImageDimensions(file).catch(() => undefined);
  const target = baiduCoverDetails[kind].target;
  return dimensions?.width === target.width && dimensions.height === target.height;
}

function baiduCounterpartCoverPrompt(options: {
  kind: BaiduCoverKind;
  sourceKind: BaiduCoverKind | "generic";
  title: string;
}) {
  const target = baiduCoverDetails[options.kind];
  const sourceDescription = options.sourceKind === "landscape"
    ? "横向"
    : options.sourceKind === "portrait"
      ? "纵向"
      : "通用";
  return [
    `根据参考的${sourceDescription}封面，为百度短剧生成一张${target.promptLabel}封面。`,
    "保持参考图中的核心人物、人物关系、服饰、时代背景、色彩气质和作品辨识度。",
    `重新构图并自然扩展画面，使最终画面适合${target.promptLabel}展示；不要简单拉伸、镜像、重复拼接、裁掉主体或添加边框。`,
    "人物面部、关键道具和剧名位于安全区域，画面完整清晰。",
    "作品名必须完整准确、清晰可读；允许分行、竖排、标点调整，以及符合海报设计的局部标题重复。",
    "除完整准确的作品名外，禁止出现任何其他文字，包括地点、年代、人物身份、角色、演员信息、宣传语、装饰性小字或剧情文案。",
    "严格禁止出现其他作品名称、随机乱码、联系方式、账号、广告引流、二维码、平台或品牌水印，以及画幅比例、尺寸、分辨率、像素值、相机参数、操作按钮、信息栏等技术或伪界面文字。",
    "参考图中的合理海报文案可以保留或重新设计；无法确认含义的装饰纹理不要强行生成为文字。",
    `作品名：${options.title}。`,
  ].join("\n");
}

async function validateBaiduGeneratedCover(options: {
  generatedFile: string;
  title: string;
  aiClient: DramaAiClient;
}) {
  const completion = await analyzeImagesAsJson(options.aiClient, {
    images: [{ type: "file", path: options.generatedFile, detail: "high" }],
    prompt: [
      "你是影视封面质量验收员。检查主标题是否可辨认，以及是否存在明显不属于商业影视海报的内容。不要把规则执行得过严。",
      `目标作品名是：“${options.title}”。允许分行、竖排、艺术字、局部重复和省略或替换标点；只要全部作品名文字完整可辨、字序正确，就应判定标题存在且可读。`,
      "除完整准确的作品名外，任何地点、年代、人物身份、角色、演员信息、宣传语、装饰性小字或剧情文案都属于禁止文字。",
      "主标题缺失或明显错字漏字、任何额外文字、其他作品名称、随机乱码、联系方式、账号、广告引流、二维码、平台水印，以及画幅比例、尺寸、分辨率、像素值、相机参数、操作按钮或伪界面文字均属于阻断问题。",
      "不确定的小字放入 warnings，不要放入 blockingIssues。请列出实际识别到的文字。",
      "只返回 JSON 对象，不要 Markdown 或解释。格式：" + JSON.stringify({
        titlePresent: true,
        titleReadable: true,
        titleSeverelyIncorrect: false,
        hasProhibitedOverlay: false,
        hasClearlyUnrelatedOrGibberishText: false,
        detectedTexts: [options.title],
        blockingIssues: [],
        warnings: [],
      }),
    ].join("\n"),
    systemPrompt: "你只输出符合用户指定结构的 JSON 对象。",
    maxTokens: 700,
    temperature: 0,
  });
  const validation = baiduAiCoverValidationSchema.parse(completion.data);
  return evaluateCommercialPosterTextValidation(options.title, validation);
}

async function generateMissingBaiduCover(options: {
  referenceFile: string;
  sourceKind: BaiduCoverKind | "generic";
  kind: BaiduCoverKind;
  title: string;
  cacheDir: string;
  aiImageModel: string;
  aiCoverGenerationRetryAttempts?: number;
  getAiClient: () => DramaAiClient;
  onLog?: (message: string) => void;
}) {
  const reference = await readFile(options.referenceFile);
  const cacheKey = createHash("sha256")
    .update(reference)
    .update(options.aiImageModel)
    .update(options.title)
    .update(options.kind)
    .update(baiduAiCoverPromptVersion)
    .digest("hex")
    .slice(0, 24);
  const cacheDirectory = path.join(options.cacheDir, cacheKey);
  const output = path.join(cacheDirectory, baiduCoverDetails[options.kind].outputName);
  if (await isPreparedCover(output, options.kind)) {
    options.onLog?.(`[baidu-cover-ai] 复用 AI ${baiduCoverDetails[options.kind].label}封面：${output}`);
    return output;
  }

  const active = activeAiCoverGenerations.get(cacheKey);
  if (active) return active;
  const operation = (async () => {
    if (await isPreparedCover(output, options.kind)) return output;
    await mkdir(cacheDirectory, { recursive: true });
    options.onLog?.(
      `[baidu-cover-ai] 正在根据${options.sourceKind === "portrait" ? "竖版" : options.sourceKind === "landscape" ? "横版" : "通用"}封面` +
        `生成${baiduCoverDetails[options.kind].label}封面，模型=${options.aiImageModel}`,
    );
    const aiClient = options.getAiClient();
    const basePrompt = baiduCounterpartCoverPrompt(options);
    const generationAttempts = Math.max(
      1,
      Math.min(11, Math.floor(options.aiCoverGenerationRetryAttempts ?? 3) + 1),
    );
    let lastError: unknown;
    let previousValidationFailure: string | undefined;
    for (let attempt = 1; attempt <= generationAttempts; attempt += 1) {
      const nonce = `${process.pid}-${Date.now()}-${attempt}`;
      const temporarySource = path.join(
        cacheDirectory,
        `.generated-${options.kind}-${nonce}.image`,
      );
      const temporaryOutput = path.join(
        cacheDirectory,
        `.prepared-${options.kind}-${nonce}.jpg`,
      );
      try {
        const retryInstruction = previousValidationFailure
          ? `\n\n上一张图片未通过文字验收，原因：${previousValidationFailure.slice(0, 600)}。` +
            "请重新生成并逐项修正，重点保证作品名完整清晰，并删除所有额外文字、其他作品名、乱码、广告引流、二维码、水印、画幅比例、尺寸、分辨率、像素值或技术界面文字。"
          : "";
        const result = await runBaiduAiWithTransientRetries({
          action: "封面生成",
          onLog: options.onLog,
          operation: () => aiClient.generateImage({
            model: options.aiImageModel,
            prompt: basePrompt + retryInstruction,
            referenceImages: [{ type: "file", path: options.referenceFile }],
            size: baiduCoverDetails[options.kind].size,
            watermark: false,
          }),
        });
        const generated = result.images[0];
        if (!generated?.data.length) {
          throw new Error("BAIDU_DRAMA_AI_COVER_RESPONSE_MISSING");
        }
        await writeFile(temporarySource, Buffer.from(generated.data));
        await prepareCroppedImageVariant({
          inputFile: temporarySource,
          outputFile: temporaryOutput,
          ...baiduCoverDetails[options.kind].target,
          jpegQuality: 92,
          maxFileBytes: 4_700_000,
          onLog: options.onLog,
        });
        const validation = await runBaiduAiWithTransientRetries({
          action: "封面文字验收",
          onLog: options.onLog,
          operation: () => validateBaiduGeneratedCover({
            generatedFile: temporaryOutput,
            title: options.title,
            aiClient,
          }),
        });
        if (!validation.passed) {
          previousValidationFailure = validation.failures.join("；");
          throw new Error(
            `BAIDU_DRAMA_AI_COVER_TEXT_VALIDATION_FAILED: ${previousValidationFailure}`,
          );
        }
        if (validation.warnings.length > 0) {
          options.onLog?.(
            `[baidu-cover-ai] 封面文字验收警告（不阻断）：${validation.warnings.join("；")}`,
          );
        }
        await rm(output, { force: true });
        await rename(temporaryOutput, output);
        options.onLog?.(
          `[baidu-cover-ai] AI ${baiduCoverDetails[options.kind].label}封面通过文字验收：${output}`,
        );
        return output;
      } catch (error) {
        lastError = error;
        options.onLog?.(
          `[baidu-cover-ai] AI 封面生成或文字验收失败：${attempt}/${generationAttempts} ` +
            errorMessage(error),
        );
        if (isBaiduAiTransientError(error)) break;
      } finally {
        await Promise.all([
          rm(temporarySource, { force: true }).catch(() => undefined),
          rm(temporaryOutput, { force: true }).catch(() => undefined),
        ]);
      }
    }
    throw Object.assign(
      new Error(`BAIDU_DRAMA_AI_COVER_GENERATION_FAILED: ${errorMessage(lastError)}`),
      { cause: lastError },
    );
  })().finally(() => {
    activeAiCoverGenerations.delete(cacheKey);
  });
  activeAiCoverGenerations.set(cacheKey, operation);
  return operation;
}

export async function prepareBaiduDramaCoverVariants(options: {
  sourceFile: string;
  landscapeSourceFile?: string;
  portraitSourceFile?: string;
  title: string;
  outputDir: string;
  aiCacheDir?: string;
  aiImageModel?: string;
  aiCoverGenerationRetryAttempts?: number;
  createAiClient?: () => DramaAiClient;
  onLog?: (message: string) => void;
}) {
  await rm(options.outputDir, { recursive: true, force: true });
  const aiCacheDir = options.aiCacheDir ?? path.join(path.dirname(options.outputDir), "ai-cover-cache");
  let landscapeSourceFile = options.landscapeSourceFile;
  let portraitSourceFile = options.portraitSourceFile;
  const needsAi = !landscapeSourceFile || !portraitSourceFile;
  let aiClient: DramaAiClient | undefined;
  const getAiClient = () => {
    if (aiClient) return aiClient;
    if (!options.createAiClient) throw new Error("DRAMA_AI_API_KEY_REQUIRED");
    aiClient = options.createAiClient();
    return aiClient;
  };
  const aiImageModel = needsAi ? options.aiImageModel?.trim() : undefined;
  if (needsAi && !aiImageModel) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");

  if (!landscapeSourceFile && portraitSourceFile) {
    landscapeSourceFile = await generateMissingBaiduCover({
      referenceFile: portraitSourceFile,
      sourceKind: "portrait",
      kind: "landscape",
      title: options.title,
      cacheDir: aiCacheDir,
      aiImageModel: aiImageModel!,
      aiCoverGenerationRetryAttempts: options.aiCoverGenerationRetryAttempts,
      getAiClient,
      onLog: options.onLog,
    });
  } else if (!portraitSourceFile && landscapeSourceFile) {
    portraitSourceFile = await generateMissingBaiduCover({
      referenceFile: landscapeSourceFile,
      sourceKind: "landscape",
      kind: "portrait",
      title: options.title,
      cacheDir: aiCacheDir,
      aiImageModel: aiImageModel!,
      aiCoverGenerationRetryAttempts: options.aiCoverGenerationRetryAttempts,
      getAiClient,
      onLog: options.onLog,
    });
  } else if (!landscapeSourceFile && !portraitSourceFile) {
    [landscapeSourceFile, portraitSourceFile] = await Promise.all([
      generateMissingBaiduCover({
        referenceFile: options.sourceFile,
        sourceKind: "generic",
        kind: "landscape",
        title: options.title,
        cacheDir: aiCacheDir,
        aiImageModel: aiImageModel!,
        aiCoverGenerationRetryAttempts: options.aiCoverGenerationRetryAttempts,
        getAiClient,
        onLog: options.onLog,
      }),
      generateMissingBaiduCover({
        referenceFile: options.sourceFile,
        sourceKind: "generic",
        kind: "portrait",
        title: options.title,
        cacheDir: aiCacheDir,
        aiImageModel: aiImageModel!,
        aiCoverGenerationRetryAttempts: options.aiCoverGenerationRetryAttempts,
        getAiClient,
        onLog: options.onLog,
      }),
    ]);
  }

  const [landscape, portrait] = await Promise.all([
    prepareCroppedImageVariant({
      inputFile: landscapeSourceFile!,
      outputFile: path.join(options.outputDir, "baidu-cover-landscape-1280x720.jpg"),
      ...BAIDU_DRAMA_LANDSCAPE_COVER_SIZE,
      jpegQuality: 92,
      maxFileBytes: 4_700_000,
      onLog: options.onLog,
    }),
    prepareCroppedImageVariant({
      inputFile: portraitSourceFile!,
      outputFile: path.join(options.outputDir, "baidu-cover-portrait-1200x1600.jpg"),
      ...BAIDU_DRAMA_PORTRAIT_COVER_SIZE,
      jpegQuality: 92,
      maxFileBytes: 4_700_000,
      onLog: options.onLog,
    }),
  ]);
  return { landscape, portrait };
}

export async function prepareBaiduDramaResources(
  task: ClaimedBaiduDramaTask,
  options: BaiduDramaRuntimeOptions,
) {
  const resourceName = baiduDramaResourceName(task);
  const localEpisodeVideoRoot = baiduDramaLocalRoot(options);
  const [
    productionProofFiles,
    licenseProofFiles,
    qualificationProofFiles,
    costProofFiles,
    commitmentFiles,
  ] =
    await Promise.all([
      prepareMaterialReferences(
        task.playlet.copyright.productionProofFiles,
        "copyright-production",
        options,
      ),
      prepareMaterialReferences(
        task.playlet.copyright.licenseProofFiles,
        "copyright-license",
        options,
      ),
      prepareMaterialReferences(
        task.playlet.qualification.proofFiles,
        "qualification",
        options,
      ),
      prepareMaterialReferences(
        task.playlet.productionCost.proofFiles,
        "production-cost",
        options,
      ),
      prepareMaterialReferences(
        task.playlet.commitmentFiles,
        "commitment",
        options,
      ),
    ]);
  task.playlet.copyright.productionProofFiles = productionProofFiles;
  task.playlet.copyright.licenseProofFiles = licenseProofFiles;
  task.playlet.qualification.proofFiles = qualificationProofFiles;
  task.playlet.productionCost.proofFiles = costProofFiles;
  task.playlet.commitmentFiles = commitmentFiles;
  await validateLocalEpisodeVideos({
    localEpisodeVideoRoot,
    resourceName,
    episodeCount: task.playlet.episodeCount,
  });
  const posters = await listLocalPosterImages({
    root: localEpisodeVideoRoot,
    resourceName,
    includeAllMatches: true,
  });
  if (posters.length === 0) {
    throw new Error("[poster-material-invalid] 未找到文件名或目录名包含“封面”或“海报”的图片");
  }
  const coverSource = posters[0];
  const landscapeSource = posters
    .filter((poster) => poster.width !== undefined && poster.height !== undefined && poster.width > poster.height)
    .sort((left, right) => (
      Math.abs((left.width! / left.height!) - (16 / 9))
      - Math.abs((right.width! / right.height!) - (16 / 9))
    ))[0];
  const portraitSource = posters
    .filter((poster) => (
    poster.width !== undefined && poster.height !== undefined && poster.height > poster.width
    ))
    .sort((left, right) => (
      Math.abs((left.width! / left.height!) - (3 / 4))
      - Math.abs((right.width! / right.height!) - (3 / 4))
    ))[0];
  const outputDir = path.join(
    options.assetDownloadDir ?? path.resolve(process.cwd(), ".drama-runs/baidu-drama/assets"),
    "poster-upload",
  );
  const onResizeLog = (message: string) =>
    log(options, `[baidu-drama] ${message}`, undefined, "resources");
  const { landscape, portrait } = await prepareBaiduDramaCoverVariants({
    sourceFile: coverSource.file,
    landscapeSourceFile: landscapeSource?.file,
    portraitSourceFile: portraitSource?.file,
    title: task.playlet.title,
    outputDir,
    aiCacheDir: path.join(
      options.assetDownloadDir ?? path.resolve(process.cwd(), ".drama-runs/baidu-drama/assets"),
      "ai-cover-cache",
    ),
    aiImageModel: options.aiImageModel,
    aiCoverGenerationRetryAttempts: options.aiCoverGenerationRetryAttempts,
    createAiClient: options.createAiClient,
    onLog: onResizeLog,
  });
  task.playlet.localCoverFile = landscape.file;
  task.playlet.localLandscapeCoverFile = landscape.file;
  task.playlet.localPortraitCoverFile = portrait.file;
  return {
    coverFile: landscape.file,
    landscapeCoverFile: landscape.file,
    portraitCoverFile: portrait.file,
    localEpisodeVideoRoot,
    resourceName,
  };
}
