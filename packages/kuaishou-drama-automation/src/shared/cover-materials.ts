import { createHash } from "node:crypto";
import { writeJsonAtomic } from "@dramabridge/file-utils";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  prepareContainedImageVariant,
  readImageDimensions,
  type LocalPosterImageFile,
} from "@dramabridge/media-assets";

import { log } from "../automation/browser-session.js";
import type {
  KuaishouDramaPublishType,
  KuaishouDramaRuntimeOptions,
  KuaishouDramaTaskConfig,
} from "./types.js";
import {
  resolveKuaishouAdVersionCount,
  resolveKuaishouAdVersionTitles,
} from "./types.js";

export const KUAISHOU_DRAMA_COVER_SIZE = {
  width: 2_208,
  height: 1_376,
} as const;

export const KUAISHOU_EPISODE_COVER_SIZE = {
  width: 1_792,
  height: 2_400,
} as const;

type KuaishouCoverKind = "drama" | "episode";
type KuaishouTextlessVariant = number;
type KuaishouTextlessVariantKind = `ad-unlock-${number}`;

export function listKuaishouTextlessVariantKinds(
  config: Pick<KuaishouDramaTaskConfig, "adVersionCount" | "publishType">
    | KuaishouDramaPublishType
    | undefined,
) {
  const adVersionCount = resolveKuaishouAdVersionCount(
    typeof config === "object" ? config : { publishType: config },
  );
  return Array.from(
    { length: Math.max(0, adVersionCount - 1) },
    (_, index): KuaishouTextlessVariantKind => `ad-unlock-${index + 2}`,
  );
}

function isTextlessVariantKind(value: string | undefined): value is KuaishouTextlessVariantKind {
  if (!value) return false;
  const match = /^ad-unlock-(\d+)$/.exec(value);
  return Boolean(match && Number(match[1]) >= 2);
}

const promptVersion = "kuaishou-cover-counterpart-v4-commercial-copy";
const textlessPromptVersion = "kuaishou-textless-v2-repair-isolated-review";
const normalizationVersion = "kuaishou-cover-contain-v1";
const maximumFileBytes = 9_500_000;
const activeGenerations = new Map<string, Promise<string>>();

const coverDetails = {
  drama: {
    label: "短剧横版封面",
    outputName: "kuaishou-drama-cover-2208x1376.jpg",
    target: KUAISHOU_DRAMA_COVER_SIZE,
  },
  episode: {
    label: "单集竖版封面",
    outputName: "kuaishou-episode-cover-1792x2400.jpg",
    target: KUAISHOU_EPISODE_COVER_SIZE,
  },
} as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function isPreparedCover(file: string, kind: KuaishouCoverKind) {
  const fileStat = await stat(file).catch(() => undefined);
  if (!fileStat?.isFile() || fileStat.size <= 0 || fileStat.size > maximumFileBytes) return false;
  const dimensions = await readImageDimensions(file).catch(() => undefined);
  const target = coverDetails[kind].target;
  return dimensions?.width === target.width && dimensions.height === target.height;
}

export function selectKuaishouCoverSources(posters: readonly LocalPosterImageFile[]) {
  const landscape = posters.find((poster) =>
    poster.width !== undefined && poster.height !== undefined && poster.width > poster.height
  );
  const portrait = posters.find((poster) =>
    poster.width !== undefined && poster.height !== undefined && poster.height > poster.width
  );
  return {
    landscape,
    portrait,
    fallback: portrait ?? landscape ?? posters[0],
  };
}

export function buildKuaishouCounterpartCoverPrompt(options: {
  kind: KuaishouCoverKind;
  title: string;
}) {
  const sourceKind = options.kind === "drama" ? "竖版" : "横版";
  const outputKind = options.kind === "drama" ? "横版" : "竖版";
  const composition = options.kind === "drama"
    ? "将竖版画面自然扩展到左右两侧，补全与原图一致的场景，必要时重新排布人物与剧名。"
    : "将横版画面重新排布为竖版，优先保留主要人物的面部、上半身、关键道具和完整剧名。";
  return [
    `根据参考${sourceKind}封面，将它改造成一张可直接发布的短剧${outputKind}成品封面。`,
    "保持原封面的核心人物、人物关系、面部特征、服饰、时代背景、色彩气质和作品辨识度。",
    composition,
    "除完整准确的剧名外，禁止出现任何其他文字；严格禁止出现地点、年代、人物身份、角色、演员信息、宣传语、装饰性小字或剧情文案。",
    "严格禁止在画面中出现画幅比例、尺寸、分辨率、像素值、相机参数、操作按钮、信息栏或任何技术参数。",
    "不得简单拉伸、镜像、重复拼接、添加边框，不得裁断人脸、头部、主要人物或关键道具。",
    "所有主要人物和剧名放在画面中央区域，四周留出充足的纯场景背景，确保发布裁剪后仍能完整展示。",
    `剧名必须完整准确地展示为“${options.title}”，不改字、不漏字；允许分行、竖排、标点调整，以及符合海报设计的局部标题重复。`,
    "除完整准确的剧名外，禁止出现任何辅助文案、地点、年代、人物身份、角色或演员信息、剧情氛围词、宣传语和装饰性小字。",
    "不得出现其他作品名称、随机乱码、联系方式、账号、广告引流、二维码、平台或品牌水印，以及画幅比例、分辨率、尺寸、相机参数、操作按钮、信息栏等技术或伪界面文字。",
    "参考图中的合理海报文案可以保留或重新设计；无法确认含义的装饰纹理不要强行生成为文字。",
    "直接输出干净的成品海报，不要输出设计稿、模板、制作说明或界面预览。",
  ].join("\n");
}

export function buildKuaishouTextlessVariantCoverPrompt(options: {
  kind: KuaishouCoverKind;
  variant: KuaishouTextlessVariant;
  summary: string;
}) {
  const directions = [
    "突出核心人物之间的情绪张力，采用具有电影感的近景和自然背景。",
    "突出故事发生的场景、关键道具和人物关系，采用有纵深感的中景构图。",
    "突出主角的行动力和关键转折，采用富有动势的构图与清晰的前后景层次。",
    "突出人物命运对比与剧情高潮，采用完整群像或具有悬念感的环境构图。",
    "突出核心冲突后的命运抉择与情感余韵，采用富有故事感的远近景结合构图。",
    "突出隐藏关系揭晓后的情感冲击，采用人物对峙与环境细节相呼应的构图。",
    "突出最终高潮与人物命运走向，采用具有收束感和视觉张力的全新构图。",
  ];
  const direction = directions[(options.variant - 2) % directions.length]!;
  return [
    `创作一张无字影视剧照，${options.kind === "drama" ? "横向" : "竖向"}构图，画面只有人物与场景。`,
    "参考图仅用于人物外貌、服饰和时代风格；不参考原图的文字、标题或海报排版。",
    `故事背景（仅用于理解情节，不要把这些内容写在图上）：${options.summary.slice(0, 600)}`,
    direction,
    "保留原剧主要人物的外貌、服饰、时代和作品辨识度；重新设计画面，不要简单裁切、拼接、镜像或复制原封面。",
    "这是一张纯画面封面。彻底去掉参考图中所有剧名、标题、文字、字母、数字、标志、水印、二维码、字幕、按钮和排版元素；不要绘制任何新文字。",
    "招牌、屏幕、书本、衣服和道具表面使用自然的纯色或无字纹理，不出现可辨认的字符。",
    "人物面部与关键道具完整自然，主体处于安全区域，四周留出裁切余量。直接输出可发布的成品图。",
  ].join("\n");
}

async function normalizedCoverCacheKey(sourceFile: string, kind: KuaishouCoverKind) {
  return createHash("sha256")
    .update(await readFile(sourceFile))
    .update(kind)
    .update(normalizationVersion)
    .digest("hex")
    .slice(0, 24);
}

async function prepareExistingCover(
  sourceFile: string,
  kind: KuaishouCoverKind,
  options: KuaishouDramaRuntimeOptions,
) {
  const outputRoot = options.assetDownloadDir?.trim();
  if (!outputRoot) throw new Error("KUAISHOU_DRAMA_COVER_OUTPUT_DIR_REQUIRED");
  const cacheKey = await normalizedCoverCacheKey(sourceFile, kind);
  const output = path.join(
    outputRoot,
    "prepared-covers",
    cacheKey,
    coverDetails[kind].outputName,
  );
  if (await isPreparedCover(output, kind)) {
    log(options, `[kuaishou-drama] reused prepared ${kind} cover: ${output}`);
    return output;
  }
  const target = coverDetails[kind].target;
  await prepareContainedImageVariant({
    inputFile: sourceFile,
    outputFile: output,
    ...target,
    jpegQuality: 92,
    maxFileBytes: maximumFileBytes,
    onLog: (message) => log(options, message),
  });
  return output;
}

async function generatedCoverCacheKey(options: {
  sourceFile: string;
  kind: KuaishouCoverKind;
  title: string;
  model: string;
  prompt: string;
  textlessVariant?: number;
}) {
  return createHash("sha256")
    .update(await readFile(options.sourceFile))
    .update(options.kind)
    .update(options.title)
    .update(options.model)
    .update(options.textlessVariant ? textlessPromptVersion : promptVersion)
    .update(options.textlessVariant ? String(options.textlessVariant) : "")
    .update(options.prompt)
    .digest("hex")
    .slice(0, 24);
}

async function isUsableGeneratedCover(options: {
  output: string;
  metadataFile: string;
  cacheKey: string;
  kind: KuaishouCoverKind;
}) {
  if (!await isPreparedCover(options.output, options.kind)) return false;
  const metadata = await readFile(options.metadataFile, "utf8")
    .then((content) => JSON.parse(content) as {
      cacheKey?: unknown;
      generationComplete?: unknown;
      validation?: { passed?: unknown };
    })
    .catch(() => undefined);
  // Accept both new generation-only metadata and previously accepted covers.
  return metadata?.cacheKey === options.cacheKey &&
    (metadata.generationComplete === true || metadata.validation?.passed === true);
}

async function generateMissingCover(options: {
  sourceFile: string;
  sourceKind: "landscape" | "portrait" | "generic";
  kind: KuaishouCoverKind;
  title: string;
  textlessVariant?: KuaishouTextlessVariant;
  summary?: string;
  runtime: KuaishouDramaRuntimeOptions;
}) {
  const outputRoot = options.runtime.assetDownloadDir?.trim();
  if (!outputRoot) throw new Error("KUAISHOU_DRAMA_COVER_OUTPUT_DIR_REQUIRED");
  if (!options.runtime.aiClient) throw new Error("DRAMA_AI_API_KEY_REQUIRED");
  const model = options.runtime.aiImageModel?.trim();
  if (!model) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");

  const prompt = options.textlessVariant
    ? buildKuaishouTextlessVariantCoverPrompt({
        kind: options.kind,
        variant: options.textlessVariant,
        summary: options.summary ?? "",
      })
    : buildKuaishouCounterpartCoverPrompt({
        kind: options.kind,
        title: options.title,
      });
  const cacheKey = await generatedCoverCacheKey({
    sourceFile: options.sourceFile,
    kind: options.kind,
    title: options.title,
    model,
    prompt,
    textlessVariant: options.textlessVariant,
  });
  const cacheDir = path.join(outputRoot, "ai-cover", cacheKey);
  const output = path.join(cacheDir, coverDetails[options.kind].outputName);
  const metadataFile = path.join(cacheDir, "generation.json");
  if (await isUsableGeneratedCover({ output, metadataFile, cacheKey, kind: options.kind })) {
    log(options.runtime, `[kuaishou-drama] reused AI ${options.kind} cover cache: ${output}`);
    return output;
  }

  const active = activeGenerations.get(cacheKey);
  if (active) return active;
  const operation = (async () => {
    if (await isUsableGeneratedCover({ output, metadataFile, cacheKey, kind: options.kind })) {
      return output;
    }
    await mkdir(cacheDir, { recursive: true });
    const target = coverDetails[options.kind].target;
    const attempts = Math.max(
      1,
      Math.min(11, Math.floor(options.runtime.aiCoverGenerationRetryAttempts ?? 3) + 1),
    );
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const temporarySource = path.join(
        cacheDir,
        `.generated-${options.kind}-${process.pid}-${Date.now()}-${attempt}.image`,
      );
      try {
        log(
          options.runtime,
          `[kuaishou-drama] generating AI ${options.kind} cover: ` +
            `variant=${options.textlessVariant ?? "original"} source=${options.sourceKind} ` +
            `attempt=${attempt}/${attempts} model=${model}`,
        );
        const result = await options.runtime.aiClient!.generateImage({
          model,
          prompt,
          referenceImages: [{ type: "file", path: options.sourceFile }],
          size: `${target.width}x${target.height}`,
          watermark: false,
        });
        const generated = result.images[0];
        if (!generated?.data.length) throw new Error("KUAISHOU_DRAMA_AI_COVER_RESPONSE_MISSING");
        await writeFile(temporarySource, Buffer.from(generated.data));
        await prepareContainedImageVariant({
          inputFile: temporarySource,
          outputFile: output,
          ...target,
          jpegQuality: 92,
          maxFileBytes: maximumFileBytes,
          onLog: (message) => log(options.runtime, message),
        });
        if (!await isPreparedCover(output, options.kind)) {
          throw new Error("生成的封面图片无法读取，或尺寸、文件大小不符合上传要求");
        }
        await writeJsonAtomic(metadataFile, {
          cacheKey,
          promptVersion: options.textlessVariant ? textlessPromptVersion : promptVersion,
          sourceFile: options.sourceFile,
          sourceKind: options.sourceKind,
          kind: options.kind,
          title: options.title,
          textlessVariant: options.textlessVariant,
          model: result.model,
          requestId: result.requestId,
          target,
          prompt,
          generationComplete: true,
          createdAt: new Date().toISOString(),
        });
        log(options.runtime, `[kuaishou-drama] AI ${options.kind} cover ready: ${output}`);
        return output;
      } catch (error) {
        lastError = error;
        await rm(output, { force: true }).catch(() => undefined);
        log(
          options.runtime,
          `[kuaishou-drama] AI ${options.kind} cover attempt failed: ` +
            `${attempt}/${attempts} ${errorMessage(error)}`,
        );
      } finally {
        await rm(temporarySource, { force: true }).catch(() => undefined);
      }
    }
    throw Object.assign(
      new Error(
        `KUAISHOU_DRAMA_AI_COVER_GENERATION_FAILED: ` +
          `${options.textlessVariant ? `广告第 ${options.textlessVariant} 版` : "原版"}${coverDetails[options.kind].label}：` +
          errorMessage(lastError),
      ),
      { cause: lastError },
    );
  })().finally(() => {
    activeGenerations.delete(cacheKey);
  });
  activeGenerations.set(cacheKey, operation);
  return operation;
}

export async function prepareKuaishouDramaCoverFiles(
  task: KuaishouDramaTaskConfig,
  posters: readonly LocalPosterImageFile[],
  options: KuaishouDramaRuntimeOptions,
) {
  const selected = selectKuaishouCoverSources(posters);
  if (!selected.fallback) throw new Error("KUAISHOU_DRAMA_COVER_SOURCE_REQUIRED");

  const dramaCoverPromise = selected.landscape
    ? prepareExistingCover(selected.landscape.file, "drama", options)
    : generateMissingCover({
        sourceFile: selected.portrait?.file ?? selected.fallback.file,
        sourceKind: selected.portrait ? "portrait" : "generic",
        kind: "drama",
        title: task.title,
        runtime: options,
      });
  const episodeCoverPromise = selected.portrait
    ? prepareExistingCover(selected.portrait.file, "episode", options)
    : generateMissingCover({
        sourceFile: selected.landscape?.file ?? selected.fallback.file,
        sourceKind: selected.landscape ? "landscape" : "generic",
        kind: "episode",
        title: task.title,
        runtime: options,
      });
  const [dramaCover, episodeCover] = await Promise.all([
    dramaCoverPromise,
    episodeCoverPromise,
  ]);

  task.localCoverFile = dramaCover;
  task.localEpisodeCoverFile = episodeCover;
  if (resolveKuaishouAdVersionCount(task) > 1) {
    task.localVariantCoverFiles = {};
    const activeVariantKinds = listKuaishouTextlessVariantKinds(task);
    const adVersionTitles = resolveKuaishouAdVersionTitles(task);
    for (const kind of activeVariantKinds) {
      const variant = Number(kind.slice("ad-unlock-".length));
      const title = adVersionTitles[variant - 2];
      if (!title) {
        throw new Error(`KUAISHOU_DRAMA_AD_VARIANT_TITLE_REQUIRED: version=${variant}`);
      }
      const generated = await Promise.allSettled([
        generateMissingCover({
          sourceFile: selected.landscape?.file ?? selected.fallback.file,
          sourceKind: selected.landscape ? "landscape" : "generic",
          kind: "drama",
          title,
          textlessVariant: variant,
          summary: task.summary,
          runtime: options,
        }),
        generateMissingCover({
          sourceFile: selected.portrait?.file ?? selected.fallback.file,
          sourceKind: selected.portrait ? "portrait" : "generic",
          kind: "episode",
          title,
          textlessVariant: variant,
          summary: task.summary,
          runtime: options,
        }),
      ]);
      const failure = generated.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const drama = generated[0]!.status === "fulfilled" ? generated[0]!.value : undefined;
      const episode = generated[1]!.status === "fulfilled" ? generated[1]!.value : undefined;
      if (!drama || !episode) throw new Error("KUAISHOU_DRAMA_AI_VARIANT_COVERS_INCOMPLETE");
      task.localVariantCoverFiles[kind] = { drama, episode };
      log(options, `[kuaishou-drama] textless covers ready: variant=${kind} drama=${drama} episode=${episode}`);
    }
  }
  log(
    options,
    `[kuaishou-drama] unified cover files ready: drama=${dramaCover} episode=${episodeCover}`,
  );
  return {
    dramaCover,
    episodeCover,
    landscapeSource: selected.landscape?.file,
    portraitSource: selected.portrait?.file,
  };
}

export function resolveKuaishouDramaCoverFile(task: KuaishouDramaTaskConfig, variant?: string) {
  const file = (isTextlessVariantKind(variant)
    ? task.localVariantCoverFiles?.[variant]?.drama
    : task.localCoverFile)?.trim();
  if (!file) throw new Error("KUAISHOU_DRAMA_LOCAL_COVER_FILE_REQUIRED");
  return file;
}

export function resolveKuaishouEpisodeCoverFile(task: KuaishouDramaTaskConfig, variant?: string) {
  const file = (isTextlessVariantKind(variant)
    ? task.localVariantCoverFiles?.[variant]?.episode
    : task.localEpisodeCoverFile)?.trim();
  if (!file) throw new Error("KUAISHOU_DRAMA_LOCAL_EPISODE_COVER_FILE_REQUIRED");
  return file;
}
