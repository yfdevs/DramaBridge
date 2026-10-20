import { app } from "electron";
import console from "node:console";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { tsImport } from "tsx/esm/api";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function configuredUserDataDir() {
  const appDataDir = app.getPath("appData");
  const candidates = ["dramabridge", "DramaBridge"]
    .map((name) => path.join(appDataDir, name));
  return candidates.find((candidate) =>
    existsSync(path.join(candidate, "global-app-config.json"))) ?? candidates[0];
}

function preparePreviewUserDataDir() {
  const configuredDir = configuredUserDataDir();
  const previewDir = path.join(app.getPath("appData"), "dramabridge-ai-preview");
  const sourceConfig = path.join(configuredDir, "global-app-config.json");
  if (!existsSync(sourceConfig)) {
    throw new Error(`GLOBAL_AI_CONFIG_FILE_NOT_FOUND: ${sourceConfig}`);
  }
  mkdirSync(previewDir, { recursive: true });
  copyFileSync(sourceConfig, path.join(previewDir, "global-app-config.json"));
  const sourceLocalState = path.join(configuredDir, "Local State");
  if (existsSync(sourceLocalState)) {
    copyFileSync(sourceLocalState, path.join(previewDir, "Local State"));
  }
  return previewDir;
}

function titleFromPosterPath(inputFile) {
  return path.basename(inputFile, path.extname(inputFile))
    .replace(/\s*-\s*(?:海报封面|海报|封面)\s*$/u, "")
    .trim();
}

export async function previewKuaishouCovers(inputFile, requestedOutputDir) {
  const sourceFile = path.resolve(inputFile);
  const sourceStat = await stat(sourceFile).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.size <= 0) {
    throw new Error(`KUAISHOU_COVER_PREVIEW_INPUT_INVALID: ${sourceFile}`);
  }

  const outputDir = requestedOutputDir
    ? path.resolve(requestedOutputDir)
    : path.join(path.dirname(sourceFile), "AI封面预览");
  await mkdir(outputDir, { recursive: true });
  const diagnosticFile = path.join(outputDir, "快手AI封面测试.log");
  await writeFile(diagnosticFile, `[${new Date().toISOString()}] 测试开始：${sourceFile}\n`);
  const log = (message) => {
    appendFileSync(diagnosticFile, `[${new Date().toISOString()}] ${message}\n`);
    console.log(message);
  };
  const sourceBaseName = path.basename(sourceFile, path.extname(sourceFile));
  const dramaPreviewFile = path.join(outputDir, `${sourceBaseName} - 快手短剧横版封面.jpg`);
  const episodePreviewFile = path.join(outputDir, `${sourceBaseName} - 快手单集竖版封面.jpg`);

  try {
    const [{ createOpenAiCompatibleClient }, automationModule, mediaAssetsModule] = await Promise.all([
      import("@dramabridge/ai"),
      import("@dramabridge/kuaishou-drama-automation"),
      import("@dramabridge/media-assets"),
    ]);
    log(`读取项目全局 AI 配置：userData=${app.getPath("userData")}`);
    const globalConfigModule = await tsImport(
      "../electron/global-app-config.ts",
      { parentURL: import.meta.url },
    );
    const clientOptions = globalConfigModule.getConfiguredAiClientOptions();
    const aiImageModel = globalConfigModule.getConfiguredAiImageModel();
    const dimensions = await mediaAssetsModule.readImageDimensions(sourceFile);
    const poster = {
      name: path.basename(sourceFile),
      file: sourceFile,
      size: sourceStat.size,
      ...dimensions,
    };
    log(
      `开始封面准备：source=${dimensions.width}x${dimensions.height} ` +
        `model=${aiImageModel} baseURL=${clientOptions.baseURL}`,
    );
    const aiClient = createOpenAiCompatibleClient({
      ...clientOptions,
      maxRetries: 0,
      timeoutMs: 300_000,
    });
    const task = {
      title: titleFromPosterPath(sourceFile),
    };
    const result = await automationModule.prepareKuaishouDramaCoverFiles(
      task,
      [poster],
      {
        aiClient,
        aiImageModel,
        coverAiGenerationAttempts: 3,
        assetDownloadDir: outputDir,
        onLog: log,
      },
    );

    await Promise.all([
      copyFile(result.dramaCover, dramaPreviewFile),
      copyFile(result.episodeCover, episodePreviewFile),
    ]);
    const [dramaDimensions, episodeDimensions] = await Promise.all([
      mediaAssetsModule.readImageDimensions(dramaPreviewFile),
      mediaAssetsModule.readImageDimensions(episodePreviewFile),
    ]);
    log(
      `测试完成：drama=${dramaDimensions.width}x${dramaDimensions.height} ` +
        `episode=${episodeDimensions.width}x${episodeDimensions.height}`,
    );

    return {
      inputFile: sourceFile,
      dramaCoverFile: dramaPreviewFile,
      episodeCoverFile: episodePreviewFile,
      diagnosticFile,
      model: aiImageModel,
    };
  } catch (error) {
    log(`测试失败：${errorMessage(error)}`);
    throw error;
  }
}

app.setName("dramabridge-ai-preview");
app.setPath("userData", preparePreviewUserDataDir());

async function runPreviewFromArguments() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const positionalArgs = args.filter((argument) => !argument.startsWith("--"));
  const inputFile = positionalArgs[0];
  if (!inputFile) {
    throw new Error(
      "请提供封面文件路径：pnpm kuaishou-drama:preview-covers -- \"D:\\path\\poster.jpg\"",
    );
  }
  const result = await previewKuaishouCovers(inputFile, positionalArgs[1]);
  console.log(`[kuaishou-cover-preview] 完成：${JSON.stringify(result)}`);
}

app.whenReady()
  .then(runPreviewFromArguments)
  .catch((error) => {
    console.error(`[kuaishou-cover-preview] 失败：${errorMessage(error)}`);
    process.exitCode = 1;
  })
  .finally(() => app.exit(process.exitCode ?? 0));
