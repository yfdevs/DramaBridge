import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DOMMatrix, DOMPoint, DOMRect, ImageData, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import type { TaobaoBatchUploadTask, TaobaoDramaRuntimeOptions } from "./types.js";

const requireBuiltinModule = createRequire(import.meta.url);
let pdfConverterPromise: Promise<typeof import("pdf-to-img")> | undefined;

function installPdfRuntimeGlobals() {
  const runtime = globalThis as unknown as Record<string, unknown>;
  const runtimeProcess = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  runtimeProcess.getBuiltinModule ??= (id) => requireBuiltinModule(id);
  runtime.DOMMatrix ??= DOMMatrix;
  runtime.DOMPoint ??= DOMPoint;
  runtime.DOMRect ??= DOMRect;
  runtime.ImageData ??= ImageData;
  runtime.Path2D ??= Path2D;
}

async function localizeCostMaterial(reference: string, outputDir: string) {
  if (!/^https?:\/\//i.test(reference)) return reference;
  const response = await fetch(reference);
  if (!response.ok) {
    throw new Error(`TAOBAO_DRAMA_COST_MATERIAL_DOWNLOAD_FAILED: status=${response.status}`);
  }
  const sourceName = path.basename(new URL(reference).pathname) || "cost-material";
  const sourceExtension = path.extname(sourceName)
    || (response.headers.get("content-type")?.includes("pdf") ? ".pdf" : "");
  const digest = createHash("sha1").update(reference).digest("hex").slice(0, 12);
  const output = path.join(
    outputDir,
    `${path.basename(sourceName, path.extname(sourceName)) || "cost-material"}-${digest}${sourceExtension}`,
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  return output;
}

async function renderFirstPdfPage(pdfFile: string, outputDir: string) {
  await mkdir(outputDir, { recursive: true });
  const output = path.join(
    outputDir,
    `${path.basename(pdfFile, path.extname(pdfFile))}-page-1.png`,
  );
  const [sourceStat, outputStat] = await Promise.all([
    stat(pdfFile),
    stat(output).catch(() => undefined),
  ]);
  if (outputStat?.isFile() && outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs) {
    return output;
  }
  try {
    installPdfRuntimeGlobals();
    pdfConverterPromise ??= import("pdf-to-img");
    const { pdf } = await pdfConverterPromise;
    const document = await pdf(pdfFile, { scale: 2 });
    const firstPage = await document.getPage(1);
    await sharp(firstPage).flatten({ background: "white" }).png().toFile(output);
  } catch (error) {
    throw new Error(
      `TAOBAO_DRAMA_COST_PDF_CONVERSION_FAILED: file=${pdfFile}; ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const converted = await stat(output).catch(() => undefined);
  if (!converted?.isFile() || converted.size <= 0) {
    throw new Error(`TAOBAO_DRAMA_COST_IMAGE_INVALID: file=${output}`);
  }
  return output;
}

export async function prepareTaobaoCostConfigImage(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  const reference = task.productionCostProofFiles[0];
  if (!reference) {
    throw new Error("TAOBAO_DRAMA_COST_MATERIAL_REQUIRED: productionCost.proofFiles 不能为空");
  }
  if (!options.assetDownloadDir?.trim()) {
    throw new Error("TAOBAO_DRAMA_ASSET_DOWNLOAD_DIR_REQUIRED");
  }
  const outputDir = path.join(options.assetDownloadDir, "cost-materials", task.id);
  const localFile = await localizeCostMaterial(reference, outputDir);
  return path.extname(localFile).toLowerCase() === ".pdf"
    ? renderFirstPdfPage(localFile, outputDir)
    : localFile;
}
