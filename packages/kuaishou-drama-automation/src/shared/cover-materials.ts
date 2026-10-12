import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyzeImagesAsJson } from "@drama/ai";
import {
  evaluateCommercialPosterTextValidation,
  prepareContainedImageVariant,
  readImageDimensions,
  type LocalPosterImageFile,
} from "@drama/drama-media-assets";
import { z } from "zod";

import { log } from "../automation/browser-session.js";
import type {
  KuaishouDramaRuntimeOptions,
  KuaishouDramaTaskConfig,
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
type KuaishouTextlessVariant = 2 | 3 | 4 | 5 | 6 | 7 | 8;
type KuaishouTextlessVariantKind = "ad-unlock-2" | "ad-unlock-3" | "ad-unlock-4" | "ad-unlock-5" | "ad-unlock-6" | "ad-unlock-7" | "ad-unlock-8";

const textlessVariants = [
  { variant: 2, kind: "ad-unlock-2", titleKey: "adVersion2Title" },
  { variant: 3, kind: "ad-unlock-3", titleKey: "adVersion3Title" },
  { variant: 4, kind: "ad-unlock-4", titleKey: "adVersion4Title" },
  { variant: 5, kind: "ad-unlock-5", titleKey: "adVersion5Title" },
  { variant: 6, kind: "ad-unlock-6", titleKey: "adVersion6Title" },
  { variant: 7, kind: "ad-unlock-7", titleKey: "adVersion7Title" },
  { variant: 8, kind: "ad-unlock-8", titleKey: "adVersion8Title" },
] as const satisfies ReadonlyArray<{
  variant: KuaishouTextlessVariant;
  kind: KuaishouTextlessVariantKind;
  titleKey: "adVersion2Title" | "adVersion3Title" | "adVersion4Title" | "adVersion5Title" | "adVersion6Title" | "adVersion7Title" | "adVersion8Title";
}>;

const textlessVariantKinds = new Set<string>(textlessVariants.map(({ kind }) => kind));

export function listKuaishouTextlessVariantKinds(
  publishType: KuaishouDramaTaskConfig["publishType"],
) {
  if (publishType === "付费" || publishType === "广告") return [];
  const versionCount = publishType === "三个广告版本"
    ? 3
    : publishType === "五个广告版本"
      ? 5
      : publishType === "六个广告版本" ? 6 : 8;
  return textlessVariants
    .slice(0, versionCount - 1)
    .map(({ kind }) => kind);
}

function isTextlessVariantKind(value: string | undefined): value is KuaishouTextlessVariantKind {
  return value !== undefined && textlessVariantKinds.has(value);
}

const promptVersion = "kuaishou-cover-counterpart-v4-commercial-copy";
const normalizationVersion = "kuaishou-cover-contain-v1";
const maximumFileBytes = 9_500_000;
const activeGenerations = new Map<string, Promise<string>>();

export const kuaishouGeneratedCoverValidationSchema = z.object({
  mainSubjectsComplete: z.boolean(),
  facesIntact: z.boolean(),
  titlePresent: z.boolean(),
  titleReadable: z.boolean(),
  titleSeverelyIncorrect: z.boolean(),
  titleInsideSafeArea: z.boolean(),
  hasProhibitedOverlay: z.boolean(),
  hasClearlyUnrelatedOrGibberishText: z.boolean(),
  noMirroringOrTiling: z.boolean(),
  referenceSimilarityConfidence: z.coerce.number().finite().min(0).max(1),
  detectedTexts: z.array(z.string().trim().max(100)).max(30).default([]),
  blockingIssues: z.array(z.string().trim().max(300)).max(20).default([]),
  warnings: z.array(z.string().trim().max(300)).max(20).default([]),
});

export type KuaishouGeneratedCoverValidation = z.infer<
  typeof kuaishouGeneratedCoverValidationSchema
>;

const coverDetails = {
  drama: {
    label: "短剧横版封面",
    ratioLabel: "414:258（约 1.605:1）横版",
    outputName: "kuaishou-drama-cover-2208x1376.jpg",
    target: KUAISHOU_DRAMA_COVER_SIZE,
  },
  episode: {
    label: "单集竖版封面",
    ratioLabel: "224:300（约 3:4）竖版",
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
  const direction: Record<KuaishouTextlessVariant, string> = {
    2: "突出核心人物之间的情绪张力，采用具有电影感的近景和自然背景。",
    3: "突出故事发生的场景、关键道具和人物关系，采用有纵深感的中景构图。",
    4: "突出主角的行动力和关键转折，采用富有动势的构图与清晰的前后景层次。",
    5: "突出人物命运对比与剧情高潮，采用完整群像或具有悬念感的环境构图。",
    6: "突出核心冲突后的命运抉择与情感余韵，采用富有故事感的远近景结合构图。",
    7: "突出隐藏关系揭晓后的情感冲击，采用人物对峙与环境细节相呼应的构图。",
    8: "突出最终高潮与人物命运走向，采用具有收束感和视觉张力的全新构图。",
  };
  return [
    `参考原剧封面及剧情简介，创作第 ${options.variant} 个广告版本的${coverDetails[options.kind].label}。`,
    `剧情简介：${options.summary}`,
    direction[options.variant],
    "保留原剧主要人物的外貌、服饰、时代和作品辨识度；重新设计画面，不要简单裁切、拼接、镜像或复制原封面。",
    "这是一张纯画面封面。彻底去掉参考图中所有剧名、标题、文字、字母、数字、标志、水印、二维码、字幕、按钮和排版元素；不要绘制任何新文字。",
    "人物面部与关键道具完整自然，主体处于安全区域，四周留出裁切余量。直接输出可发布的成品图。",
  ].join("\n");
}

function buildValidationRetryGuidance(
  title: string,
  validation: KuaishouGeneratedCoverValidation,
  textless = false,
) {
  const guidance = new Set<string>();
  if (!validation.mainSubjectsComplete) {
    guidance.add("完整呈现所有主要人物和关键道具，不要让其被边缘裁断。");
  }
  if (!validation.facesIntact) {
    guidance.add("保持参考人物的面部特征，确保人脸自然、完整、无遮挡。");
  }
  const textValidation = textless ? { failures: [] as string[] } : evaluateCommercialPosterTextValidation(title, validation);
  if (textValidation.failures.some((failure) => /剧名/.test(failure))) {
    guidance.add("完整清晰地展示准确剧名，逐字核对，不得改字或漏字。");
  }
  if (!textless && !validation.titleInsideSafeArea) {
    guidance.add("把剧名移入中央区域，与画面边缘留出明显背景空间。");
  }
  if (validation.hasProhibitedOverlay || validation.hasClearlyUnrelatedOrGibberishText) {
    guidance.add("删除所有额外文字、其他作品名、乱码、广告引流、二维码、水印、画幅比例、尺寸、分辨率、像素值或技术界面文字。");
  }
  if (textless && (validation.titlePresent || validation.detectedTexts.length > 0)) {
    guidance.add("删除画面中所有可见文字、数字、标志和水印，包括参考封面原有的剧名。");
  }
  if (!validation.noMirroringOrTiling) {
    guidance.add("自然延展场景，不要镜像、重复或拼贴背景。");
  }
  if (validation.referenceSimilarityConfidence < 0.75) {
    guidance.add("提高与参考图的人物、服饰、场景和整体气质一致性。");
  }
  return [...guidance].join("\n");
}

function validationFailure(title: string, validation: KuaishouGeneratedCoverValidation, textless = false) {
  const textValidation = textless
    ? { failures: [
        ...(validation.titlePresent || validation.detectedTexts.length > 0 ? ["text-present"] : []),
        ...(validation.hasProhibitedOverlay || validation.hasClearlyUnrelatedOrGibberishText ? ["overlay-or-gibberish"] : []),
      ] }
    : evaluateCommercialPosterTextValidation(title, validation);
  const failedChecks = [
    ["main-subjects-incomplete", validation.mainSubjectsComplete],
    ["faces-damaged", validation.facesIntact],
    ["title-outside-safe-area", textless || validation.titleInsideSafeArea],
    ["mirroring-or-tiling", validation.noMirroringOrTiling],
    ["reference-similarity-low", validation.referenceSimilarityConfidence >= 0.75],
  ].filter(([, passed]) => !passed).map(([name]) => name);
  return [...failedChecks, ...textValidation.failures].join("; ");
}

async function validateGeneratedCover(options: {
  sourceFile: string;
  generatedFile: string;
  kind: KuaishouCoverKind;
  title: string;
  textless?: boolean;
  runtime: KuaishouDramaRuntimeOptions;
}) {
  const detail = coverDetails[options.kind];
  const completion = await analyzeImagesAsJson(options.runtime.aiClient!, {
    images: [
      { type: "file", path: options.sourceFile, detail: "high" },
      { type: "file", path: options.generatedFile, detail: "high" },
    ],
    prompt: [
      "你是快手短剧封面质检员。第 1 张是参考原图，第 2 张是待验收的生成图。",
      `待验收图用于${detail.label}，目标比例为${detail.ratioLabel}。`,
      options.textless
        ? "这是无字封面。仔细检查生成图上所有可见的汉字、字母、数字、标志、字幕、水印或乱码；任何可见文字都必须填入 detectedTexts，titlePresent 表示是否残留任何标题文字。"
        : `准确剧名是：${options.title}。`,
      options.textless
        ? "只接受完全没有可见文字或标志的纯画面；主要人物、面部和关键道具必须完整。"
        : "请逐项判断：主要人物是否完整；人脸是否无畸变和遮挡；剧名是否完整可读且与四周边界至少保持约 5% 安全距离。剧名允许分行、竖排、标点调整和局部重复。",
      options.textless
        ? "参考图允许有文字，但只评估第 2 张生成图的文字。"
        : "除完整准确的剧名外，任何额外文字都必须判定为阻断问题。",
      options.textless
        ? "任何残留文字、二维码、平台水印或伪界面元素都属于阻断问题。"
        : "只把其他作品名、随机乱码、联系方式、账号、广告引流、二维码、平台水印、坐标、尺寸、时间戳、相机参数、取景框或伪界面元素判为文字阻断问题。不确定的小字放入 warnings。",
      "检查背景是否有明显镜像、重复拼接或边框，以及生成图与参考图的人物和作品辨识度是否一致。",
      "只返回 JSON 对象，不要 Markdown 或解释。布尔字段必须严格填 true/false。",
      "格式：" + JSON.stringify({
        mainSubjectsComplete: true,
        facesIntact: true,
        titlePresent: !options.textless,
        titleReadable: true,
        titleSeverelyIncorrect: false,
        titleInsideSafeArea: true,
        hasProhibitedOverlay: false,
        hasClearlyUnrelatedOrGibberishText: false,
        noMirroringOrTiling: true,
        referenceSimilarityConfidence: 0.95,
        detectedTexts: options.textless ? [] : [options.title],
        blockingIssues: [],
        warnings: [],
      }),
    ].join("\n"),
    systemPrompt: "你只输出符合用户指定结构的 JSON 对象。",
    maxTokens: 900,
    temperature: 0,
  });
  const validation = kuaishouGeneratedCoverValidationSchema.parse(completion.data);
  const textValidation = options.textless
    ? { warnings: [] as string[] }
    : evaluateCommercialPosterTextValidation(options.title, validation);
  return {
    validation,
    failure: validationFailure(options.title, validation, options.textless),
    warnings: textValidation.warnings,
    model: completion.model,
    requestId: completion.requestId,
  };
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
}) {
  return createHash("sha256")
    .update(await readFile(options.sourceFile))
    .update(options.kind)
    .update(options.title)
    .update(options.model)
    .update(promptVersion)
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
      validation?: { passed?: unknown };
    })
    .catch(() => undefined);
  return metadata?.cacheKey === options.cacheKey && metadata.validation?.passed === true;
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
    let previousFailure: string | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let retryGuidance: string | undefined;
      const temporarySource = path.join(
        cacheDir,
        `.generated-${options.kind}-${process.pid}-${Date.now()}-${attempt}.image`,
      );
      try {
        log(
          options.runtime,
          `[kuaishou-drama] generating AI ${options.kind} cover: ` +
            `source=${options.sourceKind} attempt=${attempt}/${attempts} model=${model}`,
        );
        const requestPrompt = previousFailure
          ? `${prompt}\n\n上一张生成图未通过自动验收，原因：${previousFailure.slice(0, 600)}。请重新生成并逐项修正。`
          : prompt;
        const result = await options.runtime.aiClient!.generateImage({
          model,
          prompt: requestPrompt,
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
        const validated = await validateGeneratedCover({
          sourceFile: options.sourceFile,
          generatedFile: output,
          kind: options.kind,
          title: options.title,
          textless: Boolean(options.textlessVariant),
          runtime: options.runtime,
        });
        if (validated.failure) {
          retryGuidance = buildValidationRetryGuidance(options.title, validated.validation, Boolean(options.textlessVariant));
          throw new Error(`KUAISHOU_DRAMA_AI_COVER_VALIDATION_FAILED: ${validated.failure}`);
        }
        if (validated.warnings.length > 0) {
          log(
            options.runtime,
            `[kuaishou-drama] AI ${options.kind} cover validation warnings (non-blocking): ` +
              validated.warnings.join("; "),
          );
        }
        await writeFile(metadataFile, JSON.stringify({
          cacheKey,
          promptVersion,
          sourceFile: options.sourceFile,
          sourceKind: options.sourceKind,
          kind: options.kind,
          title: options.title,
          textlessVariant: options.textlessVariant,
          model: result.model,
          requestId: result.requestId,
          target,
          prompt: requestPrompt,
          validation: {
            passed: true,
            ...validated.validation,
            model: validated.model,
            requestId: validated.requestId,
          },
          createdAt: new Date().toISOString(),
        }, null, 2));
        log(options.runtime, `[kuaishou-drama] AI ${options.kind} cover ready: ${output}`);
        return output;
      } catch (error) {
        lastError = error;
        previousFailure = retryGuidance ?? "重新生成一张干净、完整并与参考图一致的成品封面。";
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
        `KUAISHOU_DRAMA_AI_COVER_GENERATION_FAILED: ${options.kind}: ` +
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
  if (task.publishType !== "付费" && task.publishType !== "广告") {
    task.localVariantCoverFiles = {};
    const activeVariantKinds = new Set(listKuaishouTextlessVariantKinds(task.publishType));
    for (const { variant, kind, titleKey } of textlessVariants) {
      if (!activeVariantKinds.has(kind)) continue;
      const title = task[titleKey];
      if (!title) {
        throw new Error(`KUAISHOU_DRAMA_AD_VARIANT_TITLE_REQUIRED: ${titleKey}`);
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
