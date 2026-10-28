import { analyzeImagesAsJson, type DramaAiClient } from "@dramabridge/ai";
import sharp from "sharp";

export type OwnershipProjectProofAiKind = "jianying" | "juchuang" | "unknown";

async function prepareTopLeftImage(file: string, width: number, height: number) {
  const regionWidth = Math.min(width, Math.max(360, Math.round(width * 0.25)));
  const regionHeight = Math.min(height, Math.max(140, Math.round(height * 0.18)));
  return sharp(file, { failOn: "error" })
    .rotate()
    .extract({ left: 0, top: 0, width: regionWidth, height: regionHeight })
    .resize({ width: 1_200, withoutEnlargement: false })
    .flatten({ background: "white" })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

async function prepareFullImage(file: string) {
  return sharp(file, { failOn: "error" })
    .rotate()
    .resize({ width: 1_600, height: 1_200, fit: "inside", withoutEnlargement: false })
    .flatten({ background: "white" })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

async function prepareWorkspaceIdentityImage(file: string, width: number, height: number) {
  const left = Math.max(0, Math.round(width * 0.2));
  const top = Math.max(0, Math.round(height * 0.38));
  const regionWidth = Math.max(1, Math.min(width - left, Math.round(width * 0.65)));
  const regionHeight = Math.max(1, Math.min(height - top, Math.round(height * 0.55)));
  return sharp(file, { failOn: "error" })
    .rotate()
    .extract({ left, top, width: regionWidth, height: regionHeight })
    .resize({ width: 1_600, withoutEnlargement: false })
    .flatten({ background: "white" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function prepareRightWorkspaceImage(file: string, width: number, height: number) {
  const left = Math.max(0, Math.round(width * 0.7));
  return sharp(file, { failOn: "error" })
    .rotate()
    .extract({ left, top: 0, width: width - left, height })
    .resize({ width: 1_200, withoutEnlargement: false })
    .flatten({ background: "white" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

function readProofKind(data: Record<string, unknown>): OwnershipProjectProofAiKind {
  if (
    typeof data.isEngineeringScreenshot === "boolean" &&
    (typeof data.jianyingLabelVisible === "boolean" ||
      typeof data.jianyingEditorVisible === "boolean")
  ) {
    if (!data.isEngineeringScreenshot) return "unknown";
    // Cropped screenshots can retain the complete Jianying editing workspace
    // while losing its title bar. Missing branding alone is not another app.
    return data.jianyingLabelVisible === true || data.jianyingEditorVisible === true
      ? "jianying"
      : "juchuang";
  }
  // Accept older model responses during a staged rollout and in existing mocks.
  if (data.kind !== "jianying" && data.kind !== "juchuang" && data.kind !== "unknown") {
    throw new Error("OWNERSHIP_PROJECT_PROOF_AI_RESPONSE_INVALID");
  }
  return data.kind;
}

export async function classifyOwnershipProjectProofScreenshotWithAi(
  file: string,
  aiClient: DramaAiClient,
): Promise<OwnershipProjectProofAiKind> {
  const metadata = await sharp(file, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) return "unknown";

  const swapsOrientation = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const width = swapsOrientation ? metadata.height : metadata.width;
  const height = swapsOrientation ? metadata.width : metadata.height;
  if (!width || !height) return "unknown";

  const [fullImage, topLeftImage, workspaceIdentityImage, rightWorkspaceImage] = await Promise.all([
    prepareFullImage(file),
    prepareTopLeftImage(file, width, height),
    prepareWorkspaceIdentityImage(file, width, height),
    prepareRightWorkspaceImage(file, width, height),
  ]);
  try {
    const completion = await analyzeImagesAsJson(aiClient, {
      images: [fullImage, topLeftImage, workspaceIdentityImage, rightWorkspaceImage].map(
        (image) => ({
          type: "data-url" as const,
          dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
          detail: "high" as const,
        }),
      ),
      prompt: [
        "判断图片是否为视频/漫剧制作工程截图。第 1 张是完整截图，第 2 张是左上角放大区域，第 3 张是中下部工作区，第 4 张是右侧详情/提示词区域；它们都是同一张原图的裁剪。",
        "第一步先看全图是否为工程界面：可见软件导航/工具栏，并有时间线、分镜/节点画布、生成任务记录、素材输入、提示词、参数、版本修改等制作过程证据。生产记录加作品详情及输入提示词也算工程界面，不要求一定能看到节点画布。",
        "第二步判断软件来源。jianyingLabelVisible 仅表示实际可见“剪映”、Jianying 或 CapCut 品牌文字；没有看到则为 false，不要推测品牌文字。",
        "jianyingEditorVisible 表示能根据整体布局及剪映特有的控件/功能组合，明确识别为剪映编辑界面。顶部标题栏或标识被裁掉时，仍可结合素材栏、文本/字幕轨、视频音频轨、画面/音频/变速/动画面板等一致的编辑工作区证据判断为 true。不能仅凭深色界面、时间线或视频预览认定是剪映；无法确认时为 false。",
        "缺少左上角剪映标识不等于剧创。剪映界面中的“即梦AI”等入口也不代表整张图来自即梦或剧创。",
        "Guagu Studio、LiblibTV、Seedance 等只是其他工程界面的例子；不要为了识别具体平台而漏掉真实工程图。",
        "单张海报、人物头像、成片画面、只有视频预览但没有制作过程证据的页面，以及看不清是否为工程界面的图，一律 isEngineeringScreenshot=false。不要依据文件名猜测。",
        '只回答三个独立的布尔判断，不要自己决定剧创类别。格式：{"isEngineeringScreenshot":true,"jianyingLabelVisible":false,"jianyingEditorVisible":false,"evidence":"可见生产记录和右侧本次输入提示词"}。',
      ].join("\n"),
      systemPrompt: "你是工程软件截图来源识别器，只输出用户指定结构的 JSON 对象。",
      maxTokens: 120,
      temperature: 0,
    });
    const kind = readProofKind(completion.data);
    if (kind !== "unknown") return kind;

    // A first pass can miss small software labels or prompt panels. Recheck
    // ambiguous images using the two regions that carry source and edit proof.
    const recheck = await analyzeImagesAsJson(aiClient, {
      images: [fullImage, topLeftImage, rightWorkspaceImage].map((image) => ({
        type: "data-url" as const,
        dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
        detail: "high" as const,
      })),
      prompt: [
        "复核同一张图。第 1 张是全图，第 2 张放大左上角，第 3 张放大右侧制作详情。先判断是否有软件工具栏加制作过程证据，再分类。",
        "生产记录、作品详情中的本次输入、提示词、参考素材、生成参数或继续修改入口，都是制作过程证据。Guagu Studio 的此类页面应判断 isEngineeringScreenshot=true。",
        "只有海报、角色头像、成片或孤立预览，没有制作过程证据时必须判断 isEngineeringScreenshot=false；不看文件名。",
        "仅当图中实际可见剪映/Jianying/CapCut 品牌文字时 jianyingLabelVisible=true。顶部标识被裁掉时，不要直接归为其他软件：如果剪映特有的素材栏、文本/字幕轨、视频音频轨及画面/变速/动画面板等编辑控件组合足以明确确认来源，jianyingEditorVisible=true。不能只凭深色、时间线或预览推测来源。剪映内的即梦AI入口也不改变软件来源。",
        '只返回 JSON，例如 {"isEngineeringScreenshot":true,"jianyingLabelVisible":false,"jianyingEditorVisible":false,"evidence":"生成记录及本次输入提示词可见"}。',
      ].join("\n"),
      systemPrompt: "你是工程截图复核员，只输出 JSON。",
      maxTokens: 120,
      temperature: 0,
    });
    return readProofKind(recheck.data);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        `[ownership-project-proof-ai-failed] 无法使用云 AI 识别权属工程截图界面：${file}；${detail}`,
      ),
      { cause: error },
    );
  }
}
