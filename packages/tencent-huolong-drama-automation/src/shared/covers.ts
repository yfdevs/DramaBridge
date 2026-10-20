import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareContainedImageVariant } from "@dramabridge/media-assets";
import { log } from "./logger.js";
import type { ClaimedTencentHuolongDramaTask, TencentHuolongRuntimeOptions } from "./types.js";

export type TencentHuolongCoverFiles = {
  landscape: string;
  portrait: string;
  ranking: string;
  card: string;
};

const COVER_PROMPT_VERSION = "2026-09-11-commercial-copy-v3";

const targets = {
  landscape: {
    width: 1920,
    height: 1080,
    label: "横版封面",
      title: true,
    composition: "使用16:9横向主视觉构图，关键人物和冲突集中在中部安全区，底部预留剧名区域，人物面部和手部不得被裁切。",
  },
  portrait: {
    width: 770,
    height: 1080,
    generationSize: "1024x1440",
    label: "竖版封面",
    title: true,
    composition: "使用竖向人物海报构图，主人公位于中上部，底部预留清晰的大标题区域，人物面部和手部不得被裁切。",
  },
  ranking: {
    width: 2450,
    height: 800,
    label: "榜单封面",
    title: false,
    composition: "使用超宽横幅构图，人物和核心冲突集中在画面中央安全区，两侧保留可裁切背景，禁止放置任何标题或文字。",
  },
  card: {
    width: 1500,
    height: 1200,
    label: "横版卡片图",
    title: true,
    composition: "使用5:4卡片构图，主要人物居中且轮廓清楚，底部预留剧名区域，缩略图尺寸下仍要易于辨认。",
  },
} as const;

async function generateCover(
  kind: keyof typeof targets,
  sourceFile: string,
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
) {
  if (!options.aiClient) throw new Error("DRAMA_AI_API_KEY_REQUIRED");
  if (!options.aiImageModel?.trim()) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");
  if (!options.assetDownloadDir?.trim()) throw new Error("TENCENT_HUOLONG_DRAMA_ASSET_DIR_REQUIRED");
  const target = targets[kind];
  const generationSize = "generationSize" in target
    ? target.generationSize
    : `${target.width}x${target.height}`;
  const source = await readFile(sourceFile);
  const cacheKey = createHash("sha256")
    .update(source)
    .update(options.aiImageModel)
    .update(kind)
    .update(COVER_PROMPT_VERSION)
    .update("generationSize" in target ? generationSize : "")
    .update(task.playlet.title)
    .update(task.playlet.summary)
    .digest("hex").slice(0, 24);
  const outputDir = path.join(options.assetDownloadDir, "generated-covers", cacheKey);
  const output = path.join(outputDir, `${kind}-${target.width}x${target.height}.jpg`);
  if (await access(output).then(() => true, () => false)) return output;
  await mkdir(outputDir, { recursive: true });
  const titleRule = target.title
    ? [
        `画面必须清晰、完整、准确地展示中文剧名“${task.playlet.title}”；允许分行、竖排、标点调整，以及符合海报设计的局部标题重复。`,
        "剧名必须采用为本剧专门设计的中文影视海报标题字：根据剧情气质、人物关系、场景光影和参考封面的美术风格，个性化设计字形、笔画力度、排版层次与字距。",
        "标题配色必须从画面主色和光影中提取，既与背景协调又有足够对比度；可按风格使用描边、投影、光晕、金属、笔触或轻微纹理，但不得套用普通默认字体或简单白色黑边字。",
        "标题应像画面原生视觉元素一样融入构图，不得遮挡人物面部、手部或剧情关键物体；所有中文字形必须正确清楚，不得出现错字、乱码、拼音或英文替代。",
        "允许出现与作品相关的地点、年代、人物身份、角色或演员信息、剧情氛围词、简短宣传语和装饰性小字，但不能喧宾夺主。",
      ].join("\n")
    : "画面不得出现任何文字、字母、数字、标志、水印、二维码或伪界面。";
  const generationAttempts = Math.max(
    1,
    Math.min(11, Math.floor(options.aiCoverGenerationRetryAttempts ?? 3) + 1),
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= generationAttempts; attempt += 1) {
    const temporary = path.join(
      outputDir,
      `.generated-${kind}-${process.pid}-${Date.now()}-${attempt}`,
    );
    try {
      log(
        options,
        `[tencent-huolong-drama] generating AI ${kind} cover: ` +
          `attempt=${attempt}/${generationAttempts}`,
      );
      const generated = await options.aiClient.generateImage({
        model: options.aiImageModel,
        referenceImages: [{ type: "file", path: sourceFile }],
        size: generationSize,
        watermark: false,
        prompt: [
          `以参考封面中的人物身份、服饰、场景和整体美术风格为依据，重新构图生成腾讯火龙漫剧${target.label}。`,
          `目标成图比例和构图必须适配 ${target.width}×${target.height}；这是一张独立设计的版式，不是对其他尺寸封面的机械裁切。`,
          target.composition,
          "除完整准确的剧名外，禁止出现任何其他文字；严格禁止出现地点、年代、人物身份、角色、演员信息、宣传语、装饰性小字或剧情文案。",
          "严格禁止在画面中出现画幅比例、尺寸、分辨率、像素值、相机参数、操作按钮、信息栏或任何技术参数。",
          "不要添加其他作品名、随机乱码、联系方式、账号、广告引流、平台水印、二维码、边框、尺寸、分辨率、相机参数、操作按钮或伪界面。",
          titleRule,
          `剧情简介：${task.playlet.summary}`,
        ].join("\n"),
      });
      const image = generated.images[0];
      if (!image?.data.length) throw new Error("TENCENT_HUOLONG_DRAMA_AI_COVER_EMPTY");
      await writeFile(temporary, Buffer.from(image.data));
      await prepareContainedImageVariant({
        inputFile: temporary,
        outputFile: output,
        width: target.width,
        height: target.height,
        maxFileBytes: 9_500_000,
        jpegQuality: 92,
        onLog: (message) => log(options, message),
      });
      return output;
    } catch (error) {
      lastError = error;
      await rm(output, { force: true }).catch(() => undefined);
      log(
        options,
        `[tencent-huolong-drama] AI ${kind} cover attempt failed: ` +
          `${attempt}/${generationAttempts} ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw Object.assign(
    new Error(`TENCENT_HUOLONG_DRAMA_AI_COVER_GENERATION_FAILED: ${kind}`),
    { cause: lastError },
  );
}

export async function prepareTencentHuolongCovers(
  sourceFile: string,
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
): Promise<TencentHuolongCoverFiles> {
  const landscape = await generateCover("landscape", sourceFile, task, options);
  const portrait = await generateCover("portrait", sourceFile, task, options);
  const ranking = await generateCover("ranking", sourceFile, task, options);
  const card = await generateCover("card", sourceFile, task, options);
  return { landscape, portrait, ranking, card };
}
