import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import sharp from "sharp";

export type ImageUploadPolicy = {
  maxFileBytes: number;
  targetFileBytes: number;
  minimumWidth: number;
  minimumHeight: number;
  maximumWidth?: number;
  maximumHeight?: number;
  minimumJpegQuality?: number;
  targetAspectRatio?: {
    width: number;
    height: number;
    tolerance?: number;
  };
};

export type PreparedImageUploadFile = {
  sourceFile: string;
  file: string;
  originalSize: number;
  outputSize: number;
  width: number;
  height: number;
  compressed: boolean;
  quality?: number;
};

export type ImageCompressionPolicy = {
  compressAboveBytes: number;
  targetFileBytes: number;
  minimumJpegQuality?: number;
};

export type PreparedStretchedImageVariant = {
  sourceFile: string;
  file: string;
  size: number;
  width: number;
  height: number;
  quality: number;
};

export type ImageDimensions = {
  width: number;
  height: number;
};

export type ImageCropRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type FixedImageVariantOptions = {
  inputFile: string;
  outputFile: string;
  width: number;
  height: number;
  jpegQuality?: number;
  maxFileBytes?: number;
  onLog?: (message: string) => void;
};

async function prepareFixedImageVariant(
  options: FixedImageVariantOptions,
  fit: "cover" | "fill",
): Promise<PreparedStretchedImageVariant> {
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  if (width <= 0 || height <= 0) {
    throw new Error(`[image-resize-failed] 目标图片宽高必须大于 0：${width}x${height}`);
  }
  const sourceStat = await stat(options.inputFile).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.size <= 0) {
    throw new Error(`[poster-material-invalid] 图片文件不存在或为空：${options.inputFile}`);
  }

  const initialQuality = Math.max(80, Math.min(100, options.jpegQuality ?? 92));
  const qualities = [initialQuality, 88, 84, 80]
    .filter((quality, index, values) => quality <= initialQuality && values.indexOf(quality) === index)
    .sort((left, right) => right - left);
  await mkdir(path.dirname(options.outputFile), { recursive: true });
  let outputBuffer: Buffer | undefined;
  let selectedQuality = initialQuality;
  for (const quality of qualities) {
    const candidate = await sharp(options.inputFile, { failOn: "error" })
      .rotate()
      .resize({ width, height, fit, position: "centre" })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();
    if (options.maxFileBytes && candidate.length > options.maxFileBytes) continue;
    outputBuffer = candidate;
    selectedQuality = quality;
    break;
  }
  if (!outputBuffer) {
    throw new Error(
      `[image-resize-failed] 在 JPEG 质量不低于 80 的前提下无法压缩到 ` +
        `${options.maxFileBytes} 字节以内：${options.inputFile}`,
    );
  }
  await writeFile(options.outputFile, outputBuffer);

  const outputStat = await stat(options.outputFile);
  const metadata = await sharp(options.outputFile, { failOn: "error" }).metadata();
  if (metadata.width !== width || metadata.height !== height || outputStat.size <= 0) {
    throw new Error(
      `[image-resize-failed] 生成图片校验失败：expected=${width}x${height} ` +
        `actual=${metadata.width ?? 0}x${metadata.height ?? 0} file=${options.outputFile}`,
    );
  }
  const operationText = fit === "cover" ? "等比裁剪" : "拉伸";
  options.onLog?.(
    `[image-resize] ${operationText}生成图片：${options.inputFile} -> ${options.outputFile} ` +
      `${width}x${height} quality=${selectedQuality} size=${outputStat.size}`,
  );
  return {
    sourceFile: options.inputFile,
    file: options.outputFile,
    size: outputStat.size,
    width,
    height,
    quality: selectedQuality,
  };
}

export function prepareStretchedImageVariant(
  options: FixedImageVariantOptions,
): Promise<PreparedStretchedImageVariant> {
  return prepareFixedImageVariant(options, "fill");
}

export function prepareCroppedImageVariant(
  options: FixedImageVariantOptions,
): Promise<PreparedStretchedImageVariant> {
  return prepareFixedImageVariant(options, "cover");
}

/**
 * Fits the complete source image inside an exact output ratio. Any remaining
 * canvas area is filled with a darkened, blurred copy of the same image so the
 * platform cropper can show every original pixel without flat letterboxing.
 */
export async function prepareContainedImageVariant(
  options: FixedImageVariantOptions,
): Promise<PreparedStretchedImageVariant> {
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  if (width <= 0 || height <= 0) {
    throw new Error(`[image-resize-failed] 目标图片宽高必须大于 0：${width}x${height}`);
  }
  const sourceStat = await stat(options.inputFile).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.size <= 0) {
    throw new Error(`[poster-material-invalid] 图片文件不存在或为空：${options.inputFile}`);
  }

  const initialQuality = Math.max(80, Math.min(100, options.jpegQuality ?? 92));
  const qualities = [initialQuality, 88, 84, 80]
    .filter((quality, index, values) => quality <= initialQuality && values.indexOf(quality) === index)
    .sort((left, right) => right - left);
  const foreground = await sharp(options.inputFile, { failOn: "error" })
    .rotate()
    .resize({ width, height, fit: "contain" })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .jpeg({ quality: initialQuality, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((width - foreground.info.width) / 2);
  const top = Math.floor((height - foreground.info.height) / 2);
  const blurSigma = Math.max(8, Math.min(48, Math.round(Math.min(width, height) / 40)));
  await mkdir(path.dirname(options.outputFile), { recursive: true });

  let outputBuffer: Buffer | undefined;
  let selectedQuality = initialQuality;
  for (const quality of qualities) {
    const candidate = await sharp(options.inputFile, { failOn: "error" })
      .rotate()
      .resize({ width, height, fit: "cover", position: "centre" })
      .blur(blurSigma)
      .modulate({ brightness: 0.58, saturation: 0.82 })
      .composite([{ input: foreground.data, left, top }])
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();
    if (options.maxFileBytes && candidate.length > options.maxFileBytes) continue;
    outputBuffer = candidate;
    selectedQuality = quality;
    break;
  }
  if (!outputBuffer) {
    throw new Error(
      `[image-resize-failed] 在 JPEG 质量不低于 80 的前提下无法压缩到 ` +
        `${options.maxFileBytes} 字节以内：${options.inputFile}`,
    );
  }
  await writeFile(options.outputFile, outputBuffer);

  const outputStat = await stat(options.outputFile);
  const metadata = await sharp(options.outputFile, { failOn: "error" }).metadata();
  if (metadata.width !== width || metadata.height !== height || outputStat.size <= 0) {
    throw new Error(
      `[image-resize-failed] 生成图片校验失败：expected=${width}x${height} ` +
        `actual=${metadata.width ?? 0}x${metadata.height ?? 0} file=${options.outputFile}`,
    );
  }
  options.onLog?.(
    `[image-resize] 完整适配图片：${options.inputFile} -> ${options.outputFile} ` +
      `${width}x${height} quality=${selectedQuality} size=${outputStat.size}`,
  );
  return {
    sourceFile: options.inputFile,
    file: options.outputFile,
    size: outputStat.size,
    width,
    height,
    quality: selectedQuality,
  };
}

function orientedDimensions(metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>) {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return [5, 6, 7, 8].includes(metadata.orientation ?? 1)
    ? { width: height, height: width }
    : { width, height };
}

export async function readImageDimensions(inputFile: string): Promise<ImageDimensions> {
  const metadata = await sharp(inputFile, { failOn: "error" }).metadata();
  const dimensions = orientedDimensions(metadata);
  if (!dimensions.width || !dimensions.height) {
    throw new Error(`[poster-material-invalid] 无法读取图片尺寸：${inputFile}`);
  }
  return dimensions;
}

export async function prepareExtractedImageVariant(
  options: FixedImageVariantOptions & { crop: ImageCropRegion },
): Promise<PreparedStretchedImageVariant> {
  const sourceStat = await stat(options.inputFile).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.size <= 0) {
    throw new Error(`[poster-material-invalid] 图片文件不存在或为空：${options.inputFile}`);
  }

  const source = await readImageDimensions(options.inputFile);
  const crop = {
    left: Math.floor(options.crop.left),
    top: Math.floor(options.crop.top),
    width: Math.floor(options.crop.width),
    height: Math.floor(options.crop.height),
  };
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  if (
    crop.left < 0 ||
    crop.top < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.left + crop.width > source.width ||
    crop.top + crop.height > source.height
  ) {
    throw new Error(
      `[image-crop-failed] 裁剪区域越界：crop=${crop.left},${crop.top},${crop.width},${crop.height} ` +
        `source=${source.width}x${source.height} file=${options.inputFile}`,
    );
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`[image-resize-failed] 目标图片宽高必须大于 0：${width}x${height}`);
  }

  const initialQuality = Math.max(80, Math.min(100, options.jpegQuality ?? 92));
  const qualities = [initialQuality, 88, 84, 80]
    .filter((quality, index, values) => quality <= initialQuality && values.indexOf(quality) === index)
    .sort((left, right) => right - left);
  let outputBuffer: Buffer | undefined;
  let selectedQuality = initialQuality;
  for (const quality of qualities) {
    const candidate = await sharp(options.inputFile, { failOn: "error" })
      .rotate()
      .extract(crop)
      .resize({ width, height, fit: "fill" })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();
    if (options.maxFileBytes && candidate.length > options.maxFileBytes) continue;
    outputBuffer = candidate;
    selectedQuality = quality;
    break;
  }
  if (!outputBuffer) {
    throw new Error(
      `[image-crop-failed] 在 JPEG 质量不低于 80 的前提下无法压缩到 ` +
        `${options.maxFileBytes} 字节以内：${options.inputFile}`,
    );
  }

  await mkdir(path.dirname(options.outputFile), { recursive: true });
  await writeFile(options.outputFile, outputBuffer);
  const outputStat = await stat(options.outputFile);
  const outputMetadata = await sharp(options.outputFile, { failOn: "error" }).metadata();
  if (outputMetadata.width !== width || outputMetadata.height !== height || outputStat.size <= 0) {
    throw new Error(
      `[image-crop-failed] 生成图片校验失败：expected=${width}x${height} ` +
        `actual=${outputMetadata.width ?? 0}x${outputMetadata.height ?? 0} ` +
        `file=${options.outputFile}`,
    );
  }
  options.onLog?.(
    `[image-crop] 主体裁剪图片完成：${options.inputFile} -> ${options.outputFile} ` +
      `crop=${crop.left},${crop.top},${crop.width},${crop.height} ` +
      `output=${width}x${height} quality=${selectedQuality} size=${outputStat.size}`,
  );
  return {
    sourceFile: options.inputFile,
    file: options.outputFile,
    size: outputStat.size,
    width,
    height,
    quality: selectedQuality,
  };
}

function assertImagePolicy(policy: ImageUploadPolicy) {
  if (
    policy.maxFileBytes <= 0 ||
    policy.targetFileBytes <= 0 ||
    policy.targetFileBytes >= policy.maxFileBytes
  ) {
    throw new Error("[image-compress-failed] 图片目标体积必须大于 0 且小于上传上限。");
  }
  if (policy.minimumWidth <= 0 || policy.minimumHeight <= 0) {
    throw new Error("[image-compress-failed] 图片最小宽高必须大于 0。");
  }
}

function assertImageDimensions(
  inputFile: string,
  width: number,
  height: number,
  policy: ImageUploadPolicy,
) {
  if (width < policy.minimumWidth || height < policy.minimumHeight) {
    throw new Error(
      `[poster-material-invalid] 图片分辨率不足：${width}x${height}，` +
        `最低要求=${policy.minimumWidth}x${policy.minimumHeight}；文件=${inputFile}`,
    );
  }
  if (policy.targetAspectRatio) {
    const targetRatio = policy.targetAspectRatio.width / policy.targetAspectRatio.height;
    const actualRatio = width / height;
    const tolerance = policy.targetAspectRatio.tolerance ?? 0.02;
    if (Math.abs(actualRatio - targetRatio) > tolerance) {
      throw new Error(
        `[poster-material-invalid] 图片比例不符合要求：${width}x${height}，` +
          `目标比例=${policy.targetAspectRatio.width}:${policy.targetAspectRatio.height}；` +
          `文件=${inputFile}`,
      );
    }
  }
}

export async function prepareImageForUpload(options: {
  inputFile: string;
  outputDir: string;
  outputFileName: string;
  policy: ImageUploadPolicy;
  onLog?: (message: string) => void;
}): Promise<PreparedImageUploadFile> {
  assertImagePolicy(options.policy);
  const sourceStat = await stat(options.inputFile).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.size <= 0) {
    throw new Error(`[poster-material-invalid] 图片文件不存在或为空：${options.inputFile}`);
  }

  const metadata = await sharp(options.inputFile, { failOn: "error" }).metadata();
  const sourceDimensions = orientedDimensions(metadata);
  if (!sourceDimensions.width || !sourceDimensions.height) {
    throw new Error(`[poster-material-invalid] 无法读取图片尺寸：${options.inputFile}`);
  }
  assertImageDimensions(
    options.inputFile,
    sourceDimensions.width,
    sourceDimensions.height,
    options.policy,
  );

  const passthroughExtensions = new Set([".jpg", ".jpeg", ".png"]);
  const sourceExtension = path.extname(options.inputFile).toLowerCase();
  if (
    sourceStat.size <= options.policy.maxFileBytes &&
    passthroughExtensions.has(sourceExtension)
  ) {
    options.onLog?.(
      `[image-upload] 原图符合上传限制，无损直传：size=${sourceStat.size} ` +
        `dimensions=${sourceDimensions.width}x${sourceDimensions.height} file=${options.inputFile}`,
    );
    return {
      sourceFile: options.inputFile,
      file: options.inputFile,
      originalSize: sourceStat.size,
      outputSize: sourceStat.size,
      width: sourceDimensions.width,
      height: sourceDimensions.height,
      compressed: false,
    };
  }

  const maximumWidth = Math.max(
    options.policy.minimumWidth,
    options.policy.maximumWidth ?? sourceDimensions.width,
  );
  const maximumHeight = Math.max(
    options.policy.minimumHeight,
    options.policy.maximumHeight ?? sourceDimensions.height,
  );
  const initialScale = Math.min(
    1,
    maximumWidth / sourceDimensions.width,
    maximumHeight / sourceDimensions.height,
  );
  let candidateWidth = Math.max(
    options.policy.minimumWidth,
    Math.floor(sourceDimensions.width * initialScale),
  );
  let candidateHeight = Math.max(
    options.policy.minimumHeight,
    Math.floor(sourceDimensions.height * initialScale),
  );
  const minimumQuality = Math.max(1, Math.min(100, options.policy.minimumJpegQuality ?? 80));
  const qualities = [92, 88, 84, 80].filter((quality) => quality >= minimumQuality);
  if (!qualities.includes(minimumQuality)) qualities.push(minimumQuality);

  await mkdir(options.outputDir, { recursive: true });
  while (
    candidateWidth >= options.policy.minimumWidth &&
    candidateHeight >= options.policy.minimumHeight
  ) {
    for (const quality of qualities) {
      const result = await sharp(options.inputFile, { failOn: "error" })
        .rotate()
        .resize({
          width: candidateWidth,
          height: candidateHeight,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .toColourspace("srgb")
        .jpeg({
          quality,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling: "4:4:4",
        })
        .toBuffer({ resolveWithObject: true });
      if (result.data.length > options.policy.targetFileBytes) continue;

      assertImageDimensions(
        options.inputFile,
        result.info.width,
        result.info.height,
        options.policy,
      );
      const outputFile = path.join(options.outputDir, options.outputFileName);
      await writeFile(outputFile, result.data);
      options.onLog?.(
        `[image-upload] 图片压缩完成：${sourceStat.size} -> ${result.data.length} bytes ` +
          `${sourceDimensions.width}x${sourceDimensions.height} -> ` +
          `${result.info.width}x${result.info.height} quality=${quality} file=${outputFile}`,
      );
      return {
        sourceFile: options.inputFile,
        file: outputFile,
        originalSize: sourceStat.size,
        outputSize: result.data.length,
        width: result.info.width,
        height: result.info.height,
        compressed: true,
        quality,
      };
    }

    if (
      candidateWidth === options.policy.minimumWidth ||
      candidateHeight === options.policy.minimumHeight
    ) {
      break;
    }
    candidateWidth = Math.max(
      options.policy.minimumWidth,
      Math.floor(candidateWidth * 0.85),
    );
    candidateHeight = Math.max(
      options.policy.minimumHeight,
      Math.floor(candidateHeight * 0.85),
    );
  }

  throw new Error(
    `[image-compress-failed] 在不低于 ${minimumQuality} JPEG 质量和 ` +
      `${options.policy.minimumWidth}x${options.policy.minimumHeight} 分辨率的前提下，` +
      `无法将图片压缩到 ${options.policy.targetFileBytes} 字节以内：${options.inputFile}`,
  );
}

/**
 * Generic size-only image compression for platform upload materials. Images at
 * or below the threshold are returned unchanged; larger images are converted
 * to JPEG and reduced until they fit the target size while preserving aspect
 * ratio. Platform-specific dimension/crop rules should run separately.
 */
export async function compressImageForUpload(options: {
  inputFile: string;
  outputDir: string;
  outputFileName: string;
  policy: ImageCompressionPolicy;
  onLog?: (message: string) => void;
}): Promise<PreparedImageUploadFile> {
  if (
    !Number.isFinite(options.policy.compressAboveBytes)
    || !Number.isFinite(options.policy.targetFileBytes)
    || options.policy.compressAboveBytes <= 0
    || options.policy.targetFileBytes <= 0
    || options.policy.targetFileBytes >= options.policy.compressAboveBytes
  ) {
    throw new Error("[image-compress-failed] 图片压缩目标体积必须大于 0 且小于触发体积。");
  }

  const sourceStat = await stat(options.inputFile).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.size <= 0) {
    throw new Error(`[image-compress-failed] 图片文件不存在或为空：${options.inputFile}`);
  }
  const metadata = await sharp(options.inputFile, { failOn: "error" }).metadata();
  const dimensions = orientedDimensions(metadata);
  if (!dimensions.width || !dimensions.height) {
    throw new Error(`[image-compress-failed] 无法读取图片尺寸：${options.inputFile}`);
  }
  if (sourceStat.size <= options.policy.compressAboveBytes) {
    options.onLog?.(
      `[image-compress] 图片未超过压缩阈值，保持原图：size=${sourceStat.size} `
        + `threshold=${options.policy.compressAboveBytes} file=${options.inputFile}`,
    );
    return {
      sourceFile: options.inputFile,
      file: options.inputFile,
      originalSize: sourceStat.size,
      outputSize: sourceStat.size,
      width: dimensions.width,
      height: dimensions.height,
      compressed: false,
    };
  }

  return prepareImageForUpload({
    inputFile: options.inputFile,
    outputDir: options.outputDir,
    outputFileName: options.outputFileName.replace(/\.[^.]+$/u, "") + ".jpg",
    policy: {
      maxFileBytes: options.policy.compressAboveBytes,
      targetFileBytes: options.policy.targetFileBytes,
      minimumWidth: 1,
      minimumHeight: 1,
      minimumJpegQuality: options.policy.minimumJpegQuality ?? 80,
    },
    onLog: options.onLog,
  });
}
