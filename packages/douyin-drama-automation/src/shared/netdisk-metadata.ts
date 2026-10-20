import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as mammoth from "mammoth";
import { z } from "zod";
import { listLocalPosterImages } from "@dramabridge/media-assets";
import { log, warn } from "./logger.js";
import type {
  ClaimedDouyinDramaTask,
  DouyinDramaAiClient,
  DouyinDramaRole,
  DouyinDramaRuntimeOptions,
} from "./types.js";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const textExtensions = new Set([".txt", ".md", ".doc", ".docx", ".rtf"]);
const MAX_TEXT_FILES = 10;
const MAX_TOTAL_TEXT_CHARACTERS = 30_000;
const MAX_IMAGE_CANDIDATES = 100;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

function parseAiJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  const normalized = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  const candidates = [normalized];
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(normalized.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the provider-trimmed object candidate below.
    }
  }
  throw new Error("DOUYIN_DRAMA_AI_JSON_RESPONSE_INVALID");
}

const aiRoleSchema = z.object({
  name: z.string().trim().min(1).max(30),
  roleType: z.enum(["主角", "配角", "参演"]),
  intro: z.string().trim().min(1).max(100),
  photoImageId: z.string().trim().nullish(),
});

const aiMetadataSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  roles: z.array(aiRoleSchema).min(2).max(10),
});

type MetadataImage = {
  id: string;
  file: string;
  fileName: string;
  relativePath: string;
};

type MetadataInputs = {
  images: MetadataImage[];
  texts: Array<{ fileName: string; relativePath: string; content: string }>;
};

function replacementCharacterCount(value: string) {
  return [...value].filter((character) => character === "\uFFFD").length;
}

function decodeText(buffer: Buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le");
  }
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (replacementCharacterCount(utf8) <= Math.max(1, utf8.length / 200)) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    return utf8;
  }
}

function decodeRtf(buffer: Buffer) {
  const source = buffer.toString("latin1");
  return source
    .replace(/\\u(-?\d+)\??/gi, (_match, value: string) => {
      const codeUnit = Number.parseInt(value, 10);
      return String.fromCharCode(codeUnit < 0 ? codeUnit + 65_536 : codeUnit);
    })
    .replace(/(?:\\'[0-9a-f]{2})+/gi, (encoded) => {
      const bytes = Buffer.from(encoded.match(/[0-9a-f]{2}/gi)?.join("") ?? "", "hex");
      try {
        return new TextDecoder("gb18030").decode(bytes);
      } catch {
        return bytes.toString("latin1");
      }
    })
    .replace(/\\par[d]?\b/gi, "\n")
    .replace(/\\tab\b/gi, "\t")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\0/g, "")
    .trim();
}

async function readMetadataText(file: string) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0 || info.size > MAX_TEXT_FILE_BYTES) return "";
  const extension = path.extname(file).toLowerCase();
  if (extension === ".docx") {
    return (await mammoth.extractRawText({ path: file })).value.replace(/\0/g, "").trim();
  }
  if (extension === ".doc") {
    // Legacy binary DOC is discovered and downloaded, but cannot be decoded safely by Mammoth.
    return "";
  }
  const buffer = await readFile(file);
  return extension === ".rtf"
    ? decodeRtf(buffer)
    : decodeText(buffer).replace(/\0/g, "").trim();
}

function metadataTextPriority(file: string) {
  const normalized = file.replace(/\\/g, "/");
  return Number(!/剧情资料|简介|剧情|梗概|故事|介绍/u.test(normalized));
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function collectDouyinNetdiskMetadataInputs(
  resourceDir: string,
): Promise<MetadataInputs> {
  const files = await walkFiles(resourceDir);
  const preferredOriginalImageRoot = path.join(resourceDir, "海报封面", "原始图片");
  const hasOriginalImages = (await stat(preferredOriginalImageRoot).catch(() => undefined))?.isDirectory();
  const imageFiles = files
    .filter((file) => imageExtensions.has(path.extname(file).toLowerCase()))
    .filter((file) => {
      const normalized = file.replace(/\\/g, "/");
      if (/\/权属文件\//.test(normalized)) return false;
      if (hasOriginalImages) {
        return path.relative(preferredOriginalImageRoot, file).split(path.sep)[0] !== "..";
      }
      return /\/(?:海报|封面|角色|人物|头像)[^/]*\//.test(normalized)
        || /海报|封面|角色|人物|头像/.test(path.basename(file));
    })
    .slice(0, MAX_IMAGE_CANDIDATES);

  let remainingCharacters = MAX_TOTAL_TEXT_CHARACTERS;
  const textFiles = files
    .filter((file) => textExtensions.has(path.extname(file).toLowerCase()) && !path.basename(file).startsWith("~$"))
    .sort((left, right) => metadataTextPriority(left) - metadataTextPriority(right)
      || left.localeCompare(right, "zh-CN", { numeric: true }))
    .slice(0, MAX_TEXT_FILES);
  const texts: MetadataInputs["texts"] = [];
  for (const file of textFiles) {
    if (remainingCharacters <= 0) break;
    const content = await readMetadataText(file).catch(() => "");
    if (!content) continue;
    const clipped = content.slice(0, remainingCharacters);
    remainingCharacters -= clipped.length;
    texts.push({
      fileName: path.basename(file),
      relativePath: path.relative(resourceDir, file),
      content: clipped,
    });
  }

  return {
    images: imageFiles.map((file, index) => ({
      id: `image-${index + 1}`,
      file,
      fileName: path.basename(file),
      relativePath: path.relative(resourceDir, file),
    })),
    texts,
  };
}

export function douyinTaskNeedsNetdiskMetadata(task: ClaimedDouyinDramaTask) {
  return task.playlet.summary.trim().length <= 100
    || task.playlet.roles.length < 2
    || task.playlet.roles.some((role) => !role.roleType || !role.intro || !role.photoFile);
}

function mergeRoles(
  supplied: DouyinDramaRole[],
  generated: z.infer<typeof aiRoleSchema>[],
  images: MetadataImage[],
) {
  const imageForRole = (role: z.infer<typeof aiRoleSchema> | undefined) => {
    const photoImageId = role?.photoImageId?.trim();
    const selectedByAi = photoImageId
      ? images.find((image) => image.id === photoImageId)
      : undefined;
    if (selectedByAi) return selectedByAi;
    if (!role?.name) return undefined;
    const normalizedRoleName = role.name.replace(/[\s·•:：_-]/g, "").toLowerCase();
    return images.find((image) => {
      const normalizedFileName = path.parse(image.fileName).name
        .replace(/-\d+$/, "")
        .replace(/[\s·•:：_-]/g, "")
        .toLowerCase();
      return normalizedRoleName.length >= 2 && normalizedFileName.includes(normalizedRoleName);
    });
  };
  const generatedByName = new Map(generated.map((role) => [role.name, role]));
  const source: DouyinDramaRole[] = supplied.length >= 2
    ? supplied
    : generated.map((role) => ({
        name: role.name,
        roleType: role.roleType,
        intro: role.intro,
      }));
  return source.slice(0, 10).map((role, index) => {
    const generatedRole = generatedByName.get(role.name) ?? generated[index];
    const matchedImage = imageForRole(generatedRole);
    return {
      ...role,
      roleType: role.roleType ?? generatedRole?.roleType ?? (index === 0 ? "主角" : "配角"),
      intro: role.intro ?? generatedRole?.intro ?? `${role.name}是本剧重要角色。`,
      photoFile: role.photoFile ?? matchedImage?.file,
    } satisfies DouyinDramaRole;
  });
}

function buildPrompt(task: ClaimedDouyinDramaTask, inputs: MetadataInputs) {
  return [
    "请一次性整理抖音漫剧提报所需的简介和角色资料，只输出 JSON 对象，不要 Markdown。",
    "JSON 格式：{\"summary\":\"...\",\"roles\":[{\"name\":\"...\",\"roleType\":\"主角|配角|参演\",\"intro\":\"...\",\"photoImageId\":\"image-1或null\"}]}。",
    "规则：summary 必须为 101-200 个中文字符，忠于资料，不虚构关键剧情；每个角色简介不超过100字。",
    "根据简介和角色资料返回至少2个、最多10个重要角色。图片候选中能明确匹配到单人头像时填写对应 photoImageId；没有匹配头像时填写 null，后续会为该角色生成头像。不要把封面、海报、横图或竖图当成角色头像。",
    "后端已提供的简介和角色属于权威信息，应保留事实并补全缺项。所有角色和简介在这一次响应中同时完成。",
    `剧名：${task.playlet.title}`,
    `后端简介：${task.playlet.summary || "（未提供）"}`,
    `后端角色：${JSON.stringify(task.playlet.roles)}`,
    `剧情资料：${JSON.stringify(inputs.texts.map((text) => ({
      fileName: text.fileName,
      relativePath: text.relativePath,
      content: text.content,
    })))}`,
    `图片候选：${JSON.stringify(inputs.images.map((image) => ({
      imageId: image.id,
      fileName: image.fileName,
      relativePath: image.relativePath,
    })))}`,
  ].join("\n");
}

function safeRoleFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").trim() || "角色";
}

function buildRolePortraitPrompt(
  task: ClaimedDouyinDramaTask,
  role: DouyinDramaRole,
  summary: string,
) {
  return [
    "参考随请求附带的剧目封面，生成一张同一部剧角色的单人头像，用于平台角色资料上传。",
    "只展示一个角色，正面或轻微侧脸，头肩构图，五官清晰，人物完整，不要多人、拼图、海报或场景远景。",
    "画面不得包含任何文字、剧名、字幕、标志、水印、二维码、边框或界面元素。",
    "根据剧情简介、角色身份和人物介绍设计年龄、气质、服装与表情，不改变人物性别和核心身份。",
    "必须先判断参考封面属于真人实拍、写实AI、动漫、插画或3D等哪种视觉风格，并严格保持与封面一致，不要擅自把真人改成动漫，也不要把动漫改成真人。",
    "若封面中能识别到对应角色，应继承其性别、年龄、发型、脸型、服装、色彩和整体美术风格；背景简洁，不照搬封面文字。",
    `剧名：${task.playlet.title}`,
    `剧情简介：${summary}`,
    `角色姓名：${role.name}`,
    `角色性质：${role.roleType ?? "参演"}`,
    `角色介绍：${role.intro ?? `${role.name}是本剧重要角色。`}`,
  ].join("\n");
}

async function generateMissingRolePortraits(
  task: ClaimedDouyinDramaTask,
  roles: DouyinDramaRole[],
  resourceDir: string,
  options: DouyinDramaRuntimeOptions,
  client: DouyinDramaAiClient,
  summary: string,
  referenceCoverFile?: string,
) {
  const missing = roles.filter((role) => !role.photoFile);
  if (missing.length === 0) return roles;
  if (!client.generateImage) throw new Error("DOUYIN_DRAMA_AI_ROLE_IMAGE_CLIENT_REQUIRED");
  const model = options.aiImageModelFactory?.().trim();
  if (!model) throw new Error("DRAMA_AI_IMAGE_MODEL_REQUIRED");
  const outputDir = path.join(resourceDir, "海报封面", "AI角色头像");
  await mkdir(outputDir, { recursive: true });

  for (const role of missing) {
    const prompt = buildRolePortraitPrompt(task, role, summary);
    const cacheKey = createHash("sha256").update(model).update(prompt).digest("hex").slice(0, 12);
    const output = path.join(outputDir, `AI角色头像-${safeRoleFileName(role.name)}-${cacheKey}.png`);
    const existing = await stat(output).catch(() => undefined);
    if (existing?.isFile() && existing.size > 0) {
      role.photoFile = output;
      log(options, `[douyin-drama] 复用 AI 角色头像：角色=${role.name} 文件=${output}`, undefined, "metadata");
      continue;
    }
    log(options, `[douyin-drama] 网盘未匹配到角色头像，开始 AI 生成：角色=${role.name}`, {
      accountTaskId: task.accountTaskId,
      roleName: role.name,
      roleType: role.roleType,
      model,
    }, "metadata");
    let imageData: Uint8Array | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const generated = await client.generateImage({
          model,
          prompt,
          referenceImages: referenceCoverFile
            ? [{ type: "file", path: referenceCoverFile, detail: "high" }]
            : undefined,
          size: "1024x1024",
          watermark: false,
        });
        imageData = generated.images[0]?.data;
        if (!imageData?.length) {
          throw new Error(`DOUYIN_DRAMA_AI_ROLE_IMAGE_RESPONSE_MISSING: role=${role.name}`);
        }
        break;
      } catch (error) {
        lastError = error;
        warn(options, `[douyin-drama] AI 角色头像生成失败，准备重试：角色=${role.name} ${attempt}/3`, {
          accountTaskId: task.accountTaskId,
          roleName: role.name,
          error,
        }, "metadata");
      }
    }
    if (!imageData?.length) {
      throw Object.assign(
        new Error(`DOUYIN_DRAMA_AI_ROLE_IMAGE_GENERATION_FAILED: role=${role.name}`),
        { cause: lastError },
      );
    }
    await writeFile(output, Buffer.from(imageData));
    role.photoFile = output;
    log(options, `[douyin-drama] AI 角色头像生成完成：角色=${role.name} 文件=${output}`, undefined, "metadata");
  }
  return roles;
}

export async function enrichDouyinTaskFromNetdisk(
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
): Promise<ClaimedDouyinDramaTask> {
  if (!douyinTaskNeedsNetdiskMetadata(task)) return task;
  const root = options.localEpisodeVideoRoot?.trim();
  if (!root) throw new Error("DOUYIN_DRAMA_LOCAL_VIDEO_ROOT_REQUIRED");
  const resourceDir = path.join(root, task.originalTitle.trim());
  const inputs = await collectDouyinNetdiskMetadataInputs(resourceDir);
  if (task.playlet.summary.trim().length <= 100 && inputs.texts.length === 0) {
    throw new Error("DOUYIN_DRAMA_NETDISK_TEXT_REQUIRED: 后端未提供合格简介，网盘素材中也没有找到可读取的 TXT、MD、DOCX 或 RTF 文件");
  }
  if (!options.aiClientFactory) {
    throw new Error("DOUYIN_DRAMA_AI_CLIENT_REQUIRED: 网盘简介和角色资料需要全局 AI 配置");
  }

  log(options, "[douyin-drama] 开始一次性 AI 整理网盘简介、角色资料和头像文件名。", {
    accountTaskId: task.accountTaskId,
    textFiles: inputs.texts.map((text) => text.relativePath),
    imageCandidates: inputs.images.map((image) => image.relativePath),
  }, "metadata");
  const aiClient = options.aiClientFactory();
  const completion = await aiClient.generateText({
    systemPrompt: "你是短剧资料整理助手。严格基于输入资料输出合法 JSON，不解释、不追加文字。",
    prompt: buildPrompt(task, inputs),
    maxTokens: 2_000,
    temperature: 0.1,
  });
  const generated = aiMetadataSchema.parse(parseAiJsonObject(completion.text));
  const summary = task.playlet.summary.trim().length > 100
    ? task.playlet.summary.trim()
    : generated.summary;
  const roles = mergeRoles(task.playlet.roles, generated.roles, inputs.images);
  if (summary.length <= 100) {
    throw new Error(`DOUYIN_DRAMA_AI_SUMMARY_TOO_SHORT: AI 整理后的简介需要多于100字，实际=${summary.length}`);
  }
  if (roles.length < 2) {
    throw new Error(
      `DOUYIN_DRAMA_ROLE_PHOTO_REQUIRED: 网盘中至少需要找到2个可与角色姓名匹配的角色图片，实际=${roles.length}`,
    );
  }
  const referenceCover = (await listLocalPosterImages({
    root: resourceDir,
    resourceName: task.originalTitle,
    rootIsResourceDir: true,
  }))[0]?.file;
  await generateMissingRolePortraits(
    task,
    roles,
    resourceDir,
    options,
    aiClient,
    summary,
    referenceCover,
  );
  const rolesWithoutPhoto = roles.filter((role) => !role.photoFile);
  if (rolesWithoutPhoto.length > 0) {
    throw new Error(
      `DOUYIN_DRAMA_ROLE_PHOTO_REQUIRED: 网盘中找不到角色图片：${rolesWithoutPhoto.map((role) => role.name).join("、")}`,
    );
  }
  task.playlet.summary = summary.slice(0, 200);
  task.playlet.roles = roles;
  log(options, "[douyin-drama] 网盘元数据整理完成（单次 AI 调用）。", {
    accountTaskId: task.accountTaskId,
    model: completion.model,
    summaryLength: task.playlet.summary.length,
    roles: roles.map((role) => ({ name: role.name, roleType: role.roleType, photoFile: role.photoFile })),
    usage: completion.usage,
  }, "metadata");
  return task;
}
