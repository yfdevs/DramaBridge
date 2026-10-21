import { mkdirSync } from "node:fs";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createLogger as createWinstonLogger,
  format as winstonFormat,
  transports as winstonTransports,
  type transport as WinstonTransport,
} from "winston";

import { conciseLogMessageRules } from "./log-messages.js";

export type AutomationLogLevel = "debug" | "info" | "warn" | "error";
export type AutomationLogFields = Record<string, unknown>;

export type AutomationLogEntry = {
  version: 1;
  pid: number;
  time: string;
  level: AutomationLogLevel;
  platform: string;
  scope: string;
  message: string;
  context?: AutomationLogFields;
  details?: AutomationLogFields;
  error?: AutomationLogError;
};

export type AutomationLogError = {
  /** Stable code for grouping and automated handling. */
  code?: string;
  /** Full cause chain, ordered from the outer failure to its root cause. */
  codes?: string[];
  /** Short, actionable description intended for operators. */
  summary: string;
  /** Stable workflow area in which the failure occurred. */
  stage: string;
};

export type AutomationLogInput = string | AutomationLogEntry;

const browserClosedErrorPattern =
  /Target (?:page, context or browser|page|context|browser) has been closed|Target closed|(?:page|context|browser) (?:has been|was|is) closed|browser has disconnected|(?:页面|浏览器|上传页面)(?:或浏览器)?已关闭/i;

export function isBrowserClosedError(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const message =
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : typeof current === "string"
          ? current
          : typeof current === "object" && "message" in current
            ? String((current as { message?: unknown }).message ?? "")
            : String(current);
    if (browserClosedErrorPattern.test(message)) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export type AutomationErrorReportOptions = {
  fallbackMessage?: string;
  maxLength?: number;
};

const errorCodeDescriptions: Readonly<Record<string, string>> = {
  DRAMA_AI_API_KEY_REQUIRED: "请先配置 AI 服务 API Key",
  DRAMA_AI_BASE_URL_REQUIRED: "请先配置 AI 服务地址",
  DRAMA_AI_IMAGE_DATA_URL_INVALID: "AI 图片数据格式无效",
  DRAMA_AI_IMAGE_DOWNLOAD_FAILED: "AI 生成图片下载失败",
  DRAMA_AI_IMAGE_GENERATION_FAILED: "AI 图片生成服务调用失败",
  DRAMA_AI_IMAGE_MODEL_REQUIRED: "请先配置 AI 图片生成模型",
  DRAMA_AI_IMAGE_REQUIRED: "AI 图片分析缺少待处理图片",
  DRAMA_AI_IMAGE_RESPONSE_MISSING: "AI 图片生成服务未返回图片",
  DRAMA_AI_JSON_RESPONSE_INVALID: "AI 服务返回的数据格式不正确",
  DRAMA_AI_MODEL_REQUIRED: "请先配置 AI 文本模型",
  DRAMA_AI_PROMPT_REQUIRED: "AI 请求缺少提示词",
  DRAMA_AI_RESPONSE_CHOICE_MISSING: "AI 服务未返回可用结果",
  DRAMA_AI_RESPONSE_TEXT_MISSING: "AI 服务返回了空内容",
  IQIYI_DRAMA_AI_COVER_GENERATION_FAILED: "爱奇艺 AI 横版封面生成失败",
  IQIYI_DRAMA_AI_COVER_TEXT_VALIDATION_FAILED: "AI 横版封面文字验收未通过",
  IQIYI_DRAMA_AI_RECOMMENDATION_INVALID: "爱奇艺 AI 分类推荐结果无效",
  IQIYI_DRAMA_VIDEO_UPLOAD_PAGE_NOT_EMPTY: "爱奇艺上传前发现页面存在旧视频",
  IQIYI_DRAMA_VIDEO_UPLOAD_PAGE_CLEAR_FAILED: "爱奇艺上传前清理页面旧视频失败",
  BAIDU_DRAMA_AI_COVER_GENERATION_FAILED: "百度 AI 封面生成失败",
  BAIDU_DRAMA_AI_COVER_RESPONSE_MISSING: "百度 AI 封面生成服务未返回图片",
  BAIDU_DRAMA_AI_COVER_TEXT_VALIDATION_FAILED: "百度 AI 封面文字验收未通过",
  BAIDU_DRAMA_COVER_CONFIRM_NOT_READY:
    "百度封面上传未完成，图片选择后仍显示 0 张上传成功，请检查网络或平台上传状态",
  BAIDU_DRAMA_COVER_CONFIRM_NOT_CLOSED: "百度封面确认后弹窗未关闭，平台页面可能响应异常",
  BAIDU_DRAMA_COVER_FILE_INPUT_NOT_FOUND: "百度封面上传弹窗中未找到有效的图片选择控件",
  BAIDU_DRAMA_COVER_FILE_NOT_SELECTED: "百度封面文件未能写入图片选择控件",
  BAIDU_DRAMA_COVER_UPLOAD_TRANSIENT_FAILURE: "百度封面上传遇到临时故障",
  BAIDU_DRAMA_COVER_UPLOAD_REJECTED: "百度拒绝上传封面图片",
  KUAISHOU_DRAMA_AI_COVER_GENERATION_FAILED: "快手 AI 封面生成失败",
  KUAISHOU_DRAMA_AI_COVER_RESPONSE_MISSING: "快手 AI 封面生成服务未返回图片",
  KUAISHOU_DRAMA_AI_COVER_VALIDATION_FAILED: "快手 AI 封面验收未通过",
  TENCENT_HUOLONG_DRAMA_AI_COVER_GENERATION_FAILED: "腾讯火龙 AI 封面生成失败",
  TAOBAO_DRAMA_AI_COVER_GENERATION_FAILED: "淘宝短剧 AI 封面生成失败",
  TAOBAO_DRAMA_AI_COVER_RESPONSE_MISSING: "淘宝短剧 AI 封面生成服务未返回图片",
  TAOBAO_DRAMA_VIDEO_UPLOAD_REJECTED:
    "淘宝拒绝上传视频，已终止本次任务且不会自动删除或重新上传",
  AI_POSTER_GENERATION_FAILED: "AI 海报生成失败",
  AI_POSTER_IMAGE_EMPTY: "AI 海报生成服务未返回图片",
  AI_POSTER_IMAGE_INVALID: "AI 生成的海报图片无效",
  AI_POSTER_SUMMARY_REQUIRED: "生成 AI 海报需要剧目简介",
  AI_POSTER_TITLE_REQUIRED: "生成 AI 海报需要剧名",
  OWNERSHIP_PROJECT_PROOF_AI_RESPONSE_INVALID: "AI 权属材料识别结果无效",
};

const platformCodePrefixes: ReadonlyArray<readonly [string, string]> = [
  ["WECHAT_MINIPROGRAM_DRAMA_", "微信小程序"],
  ["TENCENT_HUOLONG_DRAMA_", "腾讯火龙漫剧"],
  ["TAOBAO_DRAMA_", "淘宝短剧"],
  ["PINDUODUO_DRAMA_", "拼多多"],
  ["KUAISHOU_DRAMA_", "快手"],
  ["IQIYI_DRAMA_", "爱奇艺"],
  ["DOUYIN_DRAMA_", "抖音"],
  ["BAIDU_DRAMA_", "百度"],
  ["WECHAT_DRAMA_", "微信视频号"],
  ["QQ_DRAMA_", "QQ"],
  ["MEITUAN_", "美团"],
];

const codeSuffixDescriptions: ReadonlyArray<readonly [RegExp, string]> = [
  [/ACCOUNT_CONFIG_REQUEST_FAILED$/, "账号配置请求失败"],
  [/ACCOUNT_CONFIG_RESPONSE_DATA_REQUIRED$/, "账号配置接口未返回有效数据"],
  [/ACCOUNT_TASK_CLAIM_FAILED$|TASK_CLAIM_FAILED$/, "领取提交任务失败"],
  [/ACCOUNT_TASK_REPORT_FAILED$|TASK_REPORT_FAILED$/, "提交结果上报失败"],
  [/CLAIMED_ACCOUNT_MISMATCH$/, "领取到的任务与当前账号不匹配"],
  [/CLAIMED_TASK_ID_MISMATCH$/, "领取到的任务编号不匹配"],
  [/CLAIMED_TASK_INVALID$|TASK_CONFIG_INVALID$|TASK_PAYLOAD_INVALID$/, "任务数据不完整或格式错误"],
  [/LOGIN_PAGE_OPEN_FAILED$/, "登录已失效，但登录页打开失败，请检查网络后重新登录"],
  [/LOGIN_REQUIRED$/, "登录已失效，请重新登录"],
  [/LOGIN_TIMEOUT$/, "等待登录超时"],
  [/CREATE_PAGE_NOT_READY$|CREATE_FORM_NOT_READY$|ENTRY_PAGE_NOT_READY$/, "发布页面未准备完成"],
  [/MATERIAL_PREPARATION_TIMEOUT$/, "准备提交素材超时"],
  [/MATERIAL_DOWNLOAD_FAILED$|ASSET_DOWNLOAD_FAILED$/, "素材下载失败"],
  [/ASSET_DOWNLOAD_TIMEOUT$/, "素材下载超时"],
  [/MATERIAL_FILE_NOT_FOUND$|REQUIRED_FILES_MISSING$/, "缺少任务所需素材文件"],
  [
    /LOCAL_VIDEO_ROOT_REQUIRED$|LOCAL_MATERIAL_ROOT_REQUIRED$|ASSET_DOWNLOAD_DIR_REQUIRED$/,
    "未配置本地素材目录",
  ],
  [/COVER_FILE_REQUIRED$|LOCAL_COVER_FILE_REQUIRED$|COVER_SOURCE_REQUIRED$/, "缺少封面文件"],
  [/EPISODE_UPLOAD_FAILED$|VIDEO_UPLOAD_FAILED$|FILE_UPLOAD_FAILED$/, "剧集视频或文件上传失败"],
  [/EPISODE_UPLOAD_TIMEOUT$|VIDEO_UPLOAD_TIMEOUT$|FILE_UPLOAD_TIMEOUT$/, "剧集视频或文件上传超时"],
  [/UPLOAD_FILE_COUNT_INVALID$|MATERIAL_COUNT_INVALID$/, "素材文件数量不符合要求"],
  [/FORM_INVALID$|FORM_ERROR$/, "提交表单校验未通过"],
  [
    /FIELD_NOT_FOUND$|INPUT_NOT_FOUND$|SELECT_NOT_FOUND$|RADIO_NOT_FOUND$/,
    "未找到需要填写的页面控件",
  ],
  [/OPTION_NOT_FOUND$|DROPDOWN_OPTION_NOT_FOUND$/, "未找到需要选择的页面选项"],
  [/SUBMIT_BUTTON_NOT_FOUND$/, "未找到提交按钮"],
  [/SUBMIT_FAILED$|VIDEO_SUBMIT_FAILED$/, "平台提交失败"],
  [/CHECKBOX_NOT_CHECKED$|AGREEMENT_CHECK_FAILED$/, "协议或确认选项勾选失败"],
  [/RESPONSE_DATA_REQUIRED$/, "接口未返回有效数据"],
  [/API_BASE_URL_REQUIRED$/, "未配置任务接口地址"],
];

const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const upperErrorCodePattern = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g;
const bracketErrorCodePattern = /^\[([a-z][a-z0-9_-]+)\]\s*/i;

/**
 * Converts internal automation errors into a concise Chinese message suitable for
 * task callbacks and user notifications. The original error should still be logged
 * separately so stack traces and provider responses remain available for diagnostics.
 */
export function formatAutomationErrorReport(
  error: unknown,
  options: AutomationErrorReportOptions = {},
): string {
  const rawMessages = errorCauseMessages(error);
  const codes = unique(rawMessages.flatMap((message) => extractErrorCodes(message)));
  const translated = unique(
    rawMessages.map((message) => translateErrorMessage(message)).filter(Boolean),
  );
  const fallback = options.fallbackMessage?.trim() || "任务执行失败，未获取到具体错误原因";
  const body =
    translated.length > 0
      ? [translated[0], ...translated.slice(1).map((message) => `根因：${message}`)].join("；")
      : fallback;
  const codeSuffix = codes.length > 0 ? `（错误码：${codes.join(" → ")}）` : "";
  const maxLength = Math.max(120, options.maxLength ?? 1_000);
  const maximumBodyLength = Math.max(1, maxLength - codeSuffix.length);
  const limitedBody =
    body.length > maximumBodyLength
      ? `${body.slice(0, Math.max(1, maximumBodyLength - 1)).trimEnd()}…`
      : body;
  return `${limitedBody}${codeSuffix}`;
}

function errorCauseMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const message = errorValueMessage(current);
    if (message) messages.push(sanitizeErrorMessage(message));
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return messages.filter(Boolean);
}

function errorValueMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error && "message" in error) {
    return primitiveErrorValue((error as { message?: unknown }).message);
  }
  if (error === null || error === undefined) return "";
  if (typeof error === "number" || typeof error === "bigint") return error.toString();
  if (typeof error === "boolean") return error ? "true" : "false";
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return "";
  }
}

function primitiveErrorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(ansiEscapePattern, "")
    .split(/\nCall log:|\n=+ logs =+/i)[0]
    .replace(/\n\s*-\s*waiting for[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractErrorCodes(message: string): string[] {
  const codes = message.match(upperErrorCodePattern) ?? [];
  const bracketCode = message.match(bracketErrorCodePattern)?.[1];
  const reportedCodes =
    message
      .match(/（错误码：([^）]+)）/)?.[1]
      ?.split("→")
      .map((code) => code.trim())
      .filter(Boolean) ?? [];
  return bracketCode ? [bracketCode, ...codes, ...reportedCodes] : [...codes, ...reportedCodes];
}

function translateErrorMessage(message: string): string {
  if (!message) return "";
  if (message.includes("（错误码：")) {
    return message.replace(/（错误码：[^）]+）\s*$/, "").trim();
  }

  const bracketCode = message.match(bracketErrorCodePattern)?.[1];
  const upperCode = message.match(upperErrorCodePattern)?.[0];
  const code = upperCode ?? bracketCode;
  if (code) {
    const detail = message
      .replace(bracketErrorCodePattern, "")
      .replace(code, "")
      .replace(/^[\s:：;；,-]+/, "")
      .trim();
    const actionableMessage = translateActionableError(code, detail);
    if (actionableMessage) return actionableMessage;
    const description = describeErrorCode(code);
    if (description) {
      return detail ? `${description}：${translateTechnicalDetail(detail)}` : description;
    }
    const platform = platformForErrorCode(code);
    if (detail) {
      return `${platform ? `${platform}任务执行失败` : "任务执行失败"}：${translateTechnicalDetail(
        detail,
      )}`;
    }
    return platform ? `${platform}任务执行失败` : "任务执行失败";
  }

  const translated = translateTechnicalDetail(message);
  return translated.startsWith("技术信息：") ? `任务执行失败，${translated}` : translated;
}

function translateActionableError(code: string, detail: string): string | undefined {
  if (code === "DOUYIN_DRAMA_REQUIRED_CONTRACT_DISABLED") {
    const contractId = detail.match(/\bcontractId=([^;\s]+)/u)?.[1];
    const requestedJson = detail.match(/\brequested=("(?:\\.|[^"])*")/u)?.[1];
    const availableJson = detail.match(/\bavailable=(\[[^\]]*\])/u)?.[1];
    const requested = requestedJson
      ? (() => {
          try { return String(JSON.parse(requestedJson)); } catch { return contractId; }
        })()
      : contractId;
    const available = availableJson
      ? (() => {
          try {
            const parsed = JSON.parse(availableJson);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
          } catch {
            return [];
          }
        })()
      : [];
    return `任务配置的绑定合同${requested ? `“${requested}”` : ""}当前在抖音页面中为灰色不可选，`
      + "系统已等待并重新检查，未点击该合同，以免绑定错误影响结算。"
      + (available.length > 0 ? `当前页面可选合同：${available.join("；")}。` : "当前页面没有可用合同。")
      + "请在任务后台改为适用于当前作品类型的可选合同，或先在抖音合同管理中恢复该合同后再重试";
  }

  if (code === "DOUYIN_DRAMA_REQUIRED_CONTRACT_NOT_FOUND") {
    const contractId = detail.match(/\bcontractId=([^;\s]+)/u)?.[1];
    return `任务配置的绑定合同${contractId ? `“${contractId}”` : ""}未出现在当前抖音账号的合同列表中。`
      + "请核对任务所属账号及合同编号，或在任务后台重新选择该账号可用的合同后重试";
  }

  if (code === "DOUYIN_DRAMA_EPISODE_VIDEO_INVALID") {
    const episode = detail.match(/\bepisode=(\d+)/u)?.[1];
    const file = detail.match(/\bfile=(?:"([^"]+)"|([^;]+))/u)?.slice(1).find(Boolean)?.trim();
    const source = detail.match(/\bsource=(?:"([^"]+)"|([^;]+))/u)?.slice(1).find(Boolean)?.trim();
    const sizeBytes = Number(detail.match(/\bsizeBytes=(\d+)/u)?.[1]);
    const reason = detail.match(/\breason=([^;\s]+)/u)?.[1];
    const diagnosis = reason === "moov-atom-not-found"
      ? "MP4 缺少 moov 索引，文件下载不完整或封装已损坏"
      : reason === "invalid-media-data"
        ? "视频数据无效，文件可能下载不完整或已经损坏"
        : "无法读取视频时长，文件可能损坏或格式异常";
    const target = episode ? `第 ${episode} 集视频` : "剧集视频";
    const size = Number.isFinite(sizeBytes) && sizeBytes >= 0
      ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MiB（${sizeBytes} 字节）`
      : "未知";
    return `${target}${file ? `“${file}”` : ""}校验失败，已停止上传。`
      + `诊断：${diagnosis}；文件大小：${size}`
      + `${source ? `；原始文件：${source}` : ""}。请重新下载或更换该集源视频，确认可以正常播放和拖动进度条后重新执行任务`;
  }

  if (code === "DOUYIN_DRAMA_EPISODE_DURATION_TOO_SHORT") {
    const file = detail.match(/\bfile=(?:"([^"]+)"|([^;]+))/u)?.slice(1).find(Boolean)?.trim();
    const duration = detail.match(/\bduration=([^;\s]+)/u)?.[1];
    const episode = file?.match(/第\s*(\d+)\s*集/u)?.[1];
    const target = episode ? `第 ${episode} 集视频` : "剧集视频";
    return `${target}${file ? `“${file}”` : ""}时长${duration ? `为 ${duration}，` : ""}不足 30 秒。` +
      "该视频不会自动删除或重传，请更换符合平台时长要求的源视频后重新执行任务";
  }

  if (
    code === "DOUYIN_DRAMA_EPISODE_UPLOAD_REUPLOADS_EXHAUSTED"
    || code === "DOUYIN_DRAMA_EPISODE_UPLOAD_REPLACEMENTS_EXHAUSTED"
  ) {
    const file = detail.match(/\bfile=(?:"([^"]+)"|([^;]+))/u)?.slice(1).find(Boolean)?.trim();
    const attempts = detail.match(/\breuploadAttempts=(\d+)/u)?.[1]
      ?? detail.match(/\breplaceAttempts=(\d+)/u)?.[1]
      ?? detail.match(/\bmaximum=(\d+)/u)?.[1]
      ?? "多";
    const episode = file?.match(/第\s*(\d+)\s*集/u)?.[1];
    const target = episode
      ? `第 ${episode} 集视频${file ? `“${file}”` : ""}`
      : file
        ? `剧集视频“${file}”`
        : "剧集视频";
    return `${target}连续上传失败，系统已自动删除并重新上传 ${attempts} 次仍未成功。` +
      "请检查该集源视频能否正常播放、文件是否损坏或格式异常，处理后重新执行任务";
  }

  if (code === "DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_DISABLED") {
    const column = Number(detail.match(/\bcolumn=(\d+)/u)?.[1]);
    const value = detail.match(/\bvalue=([^;\s]+)/u)?.[1];
    const unit = column === 0 ? "小时" : column === 1 ? "分钟" : column === 2 ? "秒钟" : "时间";
    const selected = value ? `“${value}”` : "目标值";
    return `平台当前不允许选择定时发布${unit}${selected}。` +
      "该时间可能已过、距离当前时间太近，或超出平台允许的预约范围，请调整发布时间后重新执行任务";
  }

  if (code === "DOUYIN_DRAMA_SCHEDULED_PUBLISH_DATE_DISABLED") {
    const date = detail.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
    return `平台当前不允许选择定时发布日期${date ? `“${date}”` : ""}。` +
      "抖音要求发布时间至少晚于当前时间 72 小时，系统会将过近日期按整天顺延后重试";
  }

  return undefined;
}

function describeErrorCode(code: string): string | undefined {
  const exact = errorCodeDescriptions[code];
  if (exact) return exact;

  const platform = platformCodePrefixes.find(([prefix]) => code.startsWith(prefix));
  const suffix = platform ? code.slice(platform[0].length) : code;
  const description = codeSuffixDescriptions.find(([pattern]) => pattern.test(suffix))?.[1];
  if (!description) return undefined;
  return platform ? `${platform[1]}${description}` : description;
}

function platformForErrorCode(code: string): string | undefined {
  return platformCodePrefixes.find(([prefix]) => code.startsWith(prefix))?.[1];
}

function translateTechnicalDetail(detail: string): string {
  const normalized = detail.trim();
  if (!normalized) return "";
  if (
    /Target (?:page, context or browser|page|context|browser) has been closed|Target closed/i.test(
      normalized,
    )
  ) {
    return "任务页面或浏览器已关闭，无法继续提交";
  }
  const timeout = normalized.match(/Timeout\s+(\d+)ms\s+exceeded|timeout(?: of)?\s+(\d+)ms/i);
  if (timeout) {
    const milliseconds = timeout[1] ?? timeout[2];
    return `页面或服务响应超时（等待 ${humanDuration(milliseconds)}），请检查网络和当前页面后重试`;
  }
  const httpStatus =
    normalized.match(/\bHTTP\s*(\d{3})\b/i)?.[1] ??
    normalized.match(/\b(?:status|statusCode)[=: ]+(\d{3})\b/i)?.[1];
  if (httpStatus) return httpFailureMessage(Number(httpStatus));
  if (/incorrect api key|invalid api key|unauthorized|authentication failed/i.test(normalized)) {
    return "服务鉴权失败，请检查 API Key 是否正确且有效";
  }
  if (/rate limit|too many requests|insufficient_quota|quota exceeded/i.test(normalized)) {
    return "服务调用频率或额度已达上限，请稍后重试并检查账户额度";
  }
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|network error|socket hang up/i.test(normalized)
  ) {
    return "网络请求失败，请检查网络连接和服务地址后重试";
  }
  if (/ETIMEDOUT|timed out|aborterror|operation was aborted/i.test(normalized)) {
    return "网络或服务响应超时，请稍后重试";
  }
  if (/ENOENT|no such file or directory|file not found/i.test(normalized)) {
    return `未找到所需文件或目录：${normalized}`;
  }
  if (/EACCES|EPERM|permission denied/i.test(normalized)) {
    return "文件访问被拒绝，请检查目录权限或文件是否被其他程序占用";
  }
  if (/^toast error:\s*/i.test(normalized)) {
    return `平台提示提交失败：${normalized.replace(/^toast error:\s*/i, "").trim()}`;
  }
  if (/strict mode violation/i.test(normalized)) {
    return "页面上出现了多个同名控件，自动化无法确定操作目标，平台页面结构可能已变化";
  }
  if (isAscii(normalized)) {
    return `技术信息：${normalized}`;
  }
  return normalized;
}

function httpFailureMessage(status: number): string {
  if (status === 400 || status === 422)
    return `服务拒绝了请求（HTTP ${status}），请检查模型及请求参数`;
  if (status === 401) return "服务鉴权失败（HTTP 401），请检查 API Key";
  if (status === 403) return "服务拒绝访问（HTTP 403），请检查账号权限或可用额度";
  if (status === 404) return "服务地址或模型不存在（HTTP 404），请检查服务配置";
  if (status === 408 || status === 504) return `服务响应超时（HTTP ${status}），请稍后重试`;
  if (status === 429) return "服务调用过于频繁或额度不足（HTTP 429），请稍后重试";
  if (status >= 500) return `服务暂时不可用（HTTP ${status}），请稍后重试`;
  return `服务请求失败（HTTP ${status}）`;
}

function humanDuration(milliseconds: string): string {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return `${milliseconds} 毫秒`;
  if (value % 60_000 === 0) return `${value / 60_000} 分钟`;
  if (value % 1_000 === 0) return `${value / 1_000} 秒`;
  return `${value} 毫秒`;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type AutomationLogMethod = {
  (message: string, fields?: AutomationLogFields): void;
  (fields: AutomationLogFields, message: string): void;
};

export type AutomationLogger = {
  debug: AutomationLogMethod;
  info: AutomationLogMethod;
  warn: AutomationLogMethod;
  error: AutomationLogMethod;
  child(options: { scope?: string; context?: AutomationLogFields }): AutomationLogger;
  callback(scope?: string, context?: AutomationLogFields): (message: string) => void;
  flush(): Promise<void>;
};

export type CreateAutomationLoggerOptions = {
  platform: string;
  scope?: string;
  context?: AutomationLogFields;
  logFilePath?: string;
  retentionDays?: number;
  onEntry?: (entry: AutomationLogEntry) => void;
  console?: boolean;
};

const cleanupKeys = new Set<string>();
const failureCleanupTimers = new Map<string, ReturnType<typeof setInterval>>();
const winstonSinkCache = new Map<string, WinstonSink>();
const secretKeyPattern = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|webhook)/i;
const legacyPlatformTags = new Set([
  "baidu",
  "baidu-netdisk",
  "baidu-drama",
  "douyin-drama",
  "iqiyi-drama",
  "kuaishou-drama",
  "meituan-drama",
  "taobao-drama",
  "pinduoduo-drama",
  "qq-drama",
  "tiktok-drama",
  "wechat-drama",
  "wechat-miniprogram-drama",
]);

const consoleColorizer = winstonFormat.colorize();
consoleColorizer.addColors({
  debug: "magentaBright",
  info: "green",
  warn: "yellow",
  error: "red",
  context: "yellow",
  muted: "gray",
});
let lastConsoleLogAt: number | undefined;

export function createAutomationLogger(options: CreateAutomationLoggerOptions): AutomationLogger {
  if (options.logFilePath) {
    const runDataDir = resolveAutomationRunDataDir({
      platform: options.platform,
      logFilePath: options.logFilePath,
    });
    scheduleAutomationFailureCleanup(
      path.join(runDataDir, failureDirectoryName),
      defaultFailureRetentionDays,
    );
  }
  // Automation services run in the Electron main process. Keep their logs visible
  // in an attached terminal by default; callers can still opt out
  // explicitly with `console: false`.
  const consoleEnabled = options.console ?? true;
  const sink = getWinstonSink({
    consoleEnabled,
    logFilePath: options.logFilePath,
    retentionDays: options.retentionDays ?? 3,
  });
  const write = (
    level: AutomationLogLevel,
    scope: string,
    context: AutomationLogFields,
    first: string | AutomationLogFields,
    second?: string | AutomationLogFields,
  ) => {
    const { message: rawMessage, fields } = resolveLogArguments(first, second);
    const parsed = parseLegacyMessage(rawMessage, scope);
    const message = normalizeLogMessage(parsed.message, parsed.scope);
    const safeContext = redactFields(context);
    const safeDetails = redactFields(fields);
    const entryScope = inferScope(parsed.scope, message);
    const error = buildStructuredLogError(level, entryScope, message, {
      ...safeContext,
      ...safeDetails,
    });
    const entry: AutomationLogEntry = {
      version: 1,
      pid: process.pid,
      time: formatLocalDateTime(new Date()),
      level,
      platform: options.platform,
      scope: entryScope,
      message,
      ...(Object.keys(safeContext).length ? { context: safeContext } : {}),
      ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}),
      ...(error ? { error } : {}),
    };

    try {
      options.onEntry?.(entry);
    } catch {
      // One unavailable sink must not block the remaining sinks.
    }
    try {
      sink?.write(entry);
    } catch {
      // Logging is observational and must never change an automation result.
    }
  };

  const build = (scope: string, context: AutomationLogFields): AutomationLogger => ({
    debug: (first, second) => write("debug", scope, context, first, second),
    info: (first, second) => write("info", scope, context, first, second),
    warn: (first, second) => write("warn", scope, context, first, second),
    error: (first, second) => write("error", scope, context, first, second),
    child(childOptions) {
      return build(childOptions.scope ?? scope, { ...context, ...childOptions.context });
    },
    callback(callbackScope = scope, callbackContext = {}) {
      return (message) =>
        write(
          levelFromLegacyMessage(message),
          callbackScope,
          { ...context, ...callbackContext },
          message,
        );
    },
    async flush() {
      await sink?.flush();
    },
  });

  return build(options.scope ?? "runtime", options.context ?? {});
}

export type AutomationFailurePage = {
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
};

export type CaptureAutomationFailureOptions = {
  platform: string;
  error: unknown;
  page?: AutomationFailurePage | null;
  runDataDir?: string;
  logFilePath?: string;
  retentionDays?: number;
  stage?: string;
  task?: AutomationLogFields;
  details?: AutomationLogFields;
};

export type AutomationFailureDiagnostic = {
  directory: string;
  recordFile: string;
  screenshotFile?: string;
  screenshotError?: string;
};

const failureDirectoryName = "failures";
const defaultFailureRetentionDays = 7;
const failureCleanupIntervalMs = 6 * 60 * 60 * 1_000;

/**
 * Saves a task failure record and, when a live Playwright-like page is available,
 * a full-page screenshot. Diagnostics are intentionally best-effort so they can
 * never replace the original automation error.
 */
export async function captureAutomationFailureDiagnostics(
  options: CaptureAutomationFailureOptions,
): Promise<AutomationFailureDiagnostic | undefined> {
  try {
    const runDataDir = resolveAutomationRunDataDir(options);
    const capturedAt = new Date();
    const failureRoot = path.join(runDataDir, failureDirectoryName);
    scheduleAutomationFailureCleanup(failureRoot, options.retentionDays);
    await cleanupAutomationFailureDirectory(failureRoot, options.retentionDays).catch(
      () => undefined,
    );

    const taskId = safePathSegment(
      primitiveErrorValue(options.task?.accountTaskId ?? options.task?.taskId) || "runtime",
    );
    const timestamp = formatFailureTimestamp(capturedAt);
    const directory = path.join(
      failureRoot,
      formatDateKey(capturedAt),
      `${timestamp}-${process.pid}-${taskId}`,
    );
    await mkdir(directory, { recursive: true });

    let pageUrl = "";
    let pageTitle = "";
    let screenshotFile: string | undefined;
    let screenshotError: string | undefined;
    if (options.page && !options.page.isClosed()) {
      pageUrl = safePageValue(() => options.page?.url() ?? "");
      pageTitle = await options.page.title().catch(() => "");
      screenshotFile = path.join(directory, "page.png");
      await options.page.screenshot({ path: screenshotFile, fullPage: true }).catch((error) => {
        screenshotError = sanitizeErrorMessage(errorValueMessage(error));
        screenshotFile = undefined;
      });
    } else {
      screenshotError = "任务页面已关闭或不可用，无法截图";
    }

    const report = formatAutomationErrorReport(options.error);
    const recordFile = path.join(directory, "error.json");
    const record = {
      version: 1,
      capturedAt: capturedAt.toISOString(),
      platform: options.platform,
      ...(options.stage ? { stage: options.stage } : {}),
      task: redactFields(options.task ?? {}),
      page: { url: pageUrl, title: pageTitle },
      error: serializeFailureError(options.error, report),
      screenshot: screenshotFile
        ? { status: "saved", file: path.basename(screenshotFile) }
        : { status: "unavailable", error: screenshotError },
      details: redactFields(options.details ?? {}),
    };
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { directory, recordFile, screenshotFile, screenshotError };
  } catch {
    return undefined;
  }
}

export async function cleanupAutomationFailureDiagnostics(options: {
  platform: string;
  runDataDir?: string;
  logFilePath?: string;
  retentionDays?: number;
}) {
  const failureRoot = path.join(resolveAutomationRunDataDir(options), failureDirectoryName);
  scheduleAutomationFailureCleanup(failureRoot, options.retentionDays);
  await cleanupAutomationFailureDirectory(failureRoot, options.retentionDays);
}

function resolveAutomationRunDataDir(options: {
  platform: string;
  runDataDir?: string;
  logFilePath?: string;
}) {
  if (options.runDataDir?.trim()) return path.resolve(options.runDataDir);
  if (options.logFilePath?.trim()) return path.dirname(path.dirname(path.resolve(options.logFilePath)));
  return path.resolve(process.cwd(), ".drama-runs", safePathSegment(options.platform));
}

function scheduleAutomationFailureCleanup(failureRoot: string, retentionDays?: number) {
  const resolvedRoot = path.resolve(failureRoot);
  if (failureCleanupTimers.has(resolvedRoot)) return;
  const clean = () =>
    void cleanupAutomationFailureDirectory(resolvedRoot, retentionDays).catch(() => undefined);
  clean();
  const timer = setInterval(clean, failureCleanupIntervalMs);
  timer.unref?.();
  failureCleanupTimers.set(resolvedRoot, timer);
}

async function cleanupAutomationFailureDirectory(failureRoot: string, retentionDays?: number) {
  const resolvedRoot = path.resolve(failureRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const cutoff = Date.now() - Math.max(1, retentionDays ?? defaultFailureRetentionDays) * 86_400_000;
  for (const dateEntry of await readdir(resolvedRoot, { withFileTypes: true }).catch(() => [])) {
    if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
    const dateDirectory = path.resolve(resolvedRoot, dateEntry.name);
    if (path.dirname(dateDirectory) !== resolvedRoot) continue;
    for (const failureEntry of await readdir(dateDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!failureEntry.isDirectory()) continue;
      const failureDirectory = path.resolve(dateDirectory, failureEntry.name);
      if (path.dirname(failureDirectory) !== dateDirectory) continue;
      const failureStat = await stat(failureDirectory).catch(() => undefined);
      if (failureStat && failureStat.mtimeMs < cutoff) {
        await rm(failureDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const remaining = await readdir(dateDirectory).catch(() => ["unavailable"]);
    if (remaining.length === 0) await rm(dateDirectory, { recursive: false }).catch(() => undefined);
  }
}

function serializeFailureError(error: unknown, report: string) {
  const causes: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      causes.push(
        redactFields({
          name: current.name,
          message: sanitizeErrorMessage(current.message),
          stack: current.stack,
        }),
      );
      current = "cause" in current ? current.cause : undefined;
      continue;
    }
    causes.push(redactFields({ message: errorValueMessage(current) }));
    break;
  }
  return { report, causes };
}

function safePageValue(read: () => string) {
  try {
    return read();
  } catch {
    return "";
  }
}

function safePathSegment(value: string) {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "unknown";
}

function formatFailureTimestamp(date: Date) {
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
    String(date.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

export function normalizeAutomationLogInput(
  input: AutomationLogInput,
  fallback: Pick<AutomationLogEntry, "platform" | "scope">,
): AutomationLogEntry {
  if (typeof input !== "string") return input;
  const parsed = parseLegacyMessage(input, fallback.scope);
  return {
    version: 1,
    pid: process.pid,
    time: formatLocalDateTime(new Date()),
    level: levelFromLegacyMessage(input),
    platform: fallback.platform,
    scope: parsed.scope,
    message: normalizeLogMessage(parsed.message, parsed.scope),
  };
}

export function formatReadableLogEntry(entry: AutomationLogEntry) {
  const pid = entry.pid ?? process.pid;
  const level = formatLevel(entry.level);
  const context = formatLogContext(entry);
  const metadata = formatLogMetadata(entry);
  return `[Drama] ${pid} - ${entry.time} ${level.padStart(7)} ${context} ${entry.message}${metadata ? ` ${metadata}` : ""}`;
}

function formatConsoleLogEntry(entry: AutomationLogEntry) {
  const now = Date.now();
  const elapsed = lastConsoleLogAt === undefined ? undefined : now - lastConsoleLogAt;
  lastConsoleLogAt = now;
  const level = formatLevel(entry.level).padStart(7);
  const prefix = consoleColorizer.colorize(entry.level, `[Drama] ${entry.pid ?? process.pid} -`);
  const coloredLevel = consoleColorizer.colorize(entry.level, level);
  const context = consoleColorizer.colorize("context", formatLogContext(entry));
  const message = consoleColorizer.colorize(entry.level, entry.message);
  const metadata = formatLogMetadata(entry);
  const coloredMetadata = metadata ? ` ${consoleColorizer.colorize("muted", metadata)}` : "";
  const timestampDiff =
    elapsed === undefined || elapsed >= 60_000
      ? ""
      : consoleColorizer.colorize("context", ` +${elapsed}ms`);
  return `${prefix} ${entry.time} ${coloredLevel} ${context} ${message}${coloredMetadata}${timestampDiff}`;
}

function formatLevel(level: AutomationLogLevel) {
  return level === "info" ? "LOG" : level.toUpperCase();
}

function formatLogContext(entry: AutomationLogEntry) {
  return `[${formatIdentifier(entry.platform)}:${formatIdentifier(entry.scope)}]`;
}

function formatLogMetadata(entry: AutomationLogEntry) {
  const fields = { ...entry.context, ...entry.details };
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatFieldValue(key, value)}`)
    .join(", ");
  return detail ? `{ ${detail} }` : "";
}

function formatIdentifier(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "UNKNOWN"
  );
}

export function formatDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function resolveLogArguments(
  first: string | AutomationLogFields,
  second?: string | AutomationLogFields,
) {
  if (typeof first === "string") {
    return {
      message: first,
      fields: typeof second === "object" && second ? second : {},
    };
  }
  return {
    message: typeof second === "string" ? second : "Log entry",
    fields: first,
  };
}

function parseLegacyMessage(message: string, fallbackScope: string) {
  let remaining = message.trim();
  let scope = fallbackScope;
  for (;;) {
    const match = /^\[([^\]]+)]\s*/.exec(remaining);
    if (!match) break;
    const tag = match[1].trim().toLowerCase();
    const mappedScope = scopeFromLegacyTag(tag);
    if (!legacyPlatformTags.has(tag) && !mappedScope) break;
    if (mappedScope) scope = mappedScope;
    remaining = remaining.slice(match[0].length).trim();
  }
  return { scope, message: remaining || "记录运行信息" };
}

function scopeFromLegacyTag(tag: string) {
  if (
    /^(account|api|auth|browser|config|download|form|material|notification|publish|runtime|storage|submit|system|task|upload|worker)$/.test(
      tag,
    )
  )
    return tag;
  if (
    /^(task-api|idle-refresh|video-account-sync|video-transcode|resources|automation|polling|dropdown)$/.test(
      tag,
    )
  )
    return tag;
  if (/^(baidu|baidu-transfer|disk-cleanup)$/.test(tag)) return "netdisk";
  if (/^(download|video-transcode.*)$/.test(tag)) return "download";
  if (/^(video-assets|material|poster)$/.test(tag)) return "material";
  if (
    /^(poster-material-invalid|image-compress-failed|local-video-invalid|production-proof-invalid)$/.test(
      tag,
    )
  )
    return "material";
  if (/^(video-transcode-cancelled|video-transcode-failed)$/.test(tag)) return "video-transcode";
  if (/^(upload.*|vod.*)$/.test(tag)) return "upload";
  if (/^(login|check)$/.test(tag)) return "auth";
  if (/^(fill|form)$/.test(tag)) return "form";
  if (/^(task|step|retry|step-timeout)$/.test(tag)) return "task";
  if (/^(submit|action|wait)$/.test(tag)) return "submit";
  if (/^(browser|idle-refresh)$/.test(tag)) return "browser";
  if (/^(config)$/.test(tag)) return "config";
  if (/^(skip|warn|debug)$/.test(tag)) return fallbackScopeFromTag(tag);
  return undefined;
}

function fallbackScopeFromTag(tag: string) {
  return tag === "debug" ? "system" : "runtime";
}

function levelFromLegacyMessage(message: string): AutomationLogLevel {
  if (/\bfatal\b|阻断性/i.test(message)) return "error";
  if (
    /^\[(warn|skip|retry)]/i.test(message) ||
    /\b(retry|retrying|fallback|skipped|timeout|warning|rejected)\b|重试|跳过|超时|警告|拒绝/i.test(
      message,
    )
  )
    return "warn";
  if (/\b(failed|failure|error|失败|异常|错误)\b/i.test(message)) return "error";
  return "info";
}

function normalizeMessage(message: string) {
  return message
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/, "");
}

function normalizeLogMessage(message: string, scope: string) {
  const normalized = normalizeMessage(message);
  for (const [pattern, replacement] of conciseLogMessageRules) {
    if (pattern.test(normalized)) return replacement;
  }
  if (scope === "runtime") return normalized.replace(/^运行时停止$/u, "服务停止");
  return normalized;
}

function buildStructuredLogError(
  level: AutomationLogLevel,
  scope: string,
  message: string,
  fields: AutomationLogFields,
): AutomationLogError | undefined {
  const errorValue = fields.error ?? fields.errorMessage ?? fields.reason;
  if (level !== "error" && errorValue === undefined) return undefined;

  const rawMessages = errorCauseMessages(errorValue ?? message);
  const codes = unique(rawMessages.flatMap((item) => extractErrorCodes(item)));
  const stageValue = fields.failStage ?? fields.stage ?? fields.step ?? scope;
  const stage = primitiveErrorValue(stageValue).trim() || scope;
  const summary = formatAutomationErrorReport(errorValue ?? message, {
    fallbackMessage: message,
    maxLength: 600,
  });

  return {
    ...(codes[0] ? { code: codes[0], codes } : {}),
    summary,
    stage,
  };
}

function inferScope(scope: string, message: string) {
  if (scope !== "runtime" && scope !== "system") return scope;
  if (/登录|账号已登录|扫码|login|credential/i.test(message)) return "auth";
  if (/浏览器|页面|browser|tab\b/i.test(message)) return "browser";
  if (/网盘|下载|转存|netdisk|download/i.test(message)) return "netdisk";
  if (/封面|海报|权属|版权|素材|制作证明|cover|poster|material/i.test(message)) return "material";
  if (/上传|upload|VOD/i.test(message)) return "upload";
  if (/提交|提审|审核|submit|review/i.test(message)) return "submit";
  if (/填写|字段|选择|按钮|表单|角色|价格|fill|select|field|form|actor|price/i.test(message))
    return "form";
  if (/接口|回调|上报|API/i.test(message)) return "api";
  if (/任务|领取|轮询|task|claim|poll/i.test(message)) return "task";
  return scope;
}

function formatLocalDateTime(date: Date) {
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
  return `${formatDateKey(date)} ${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function redactFields(fields: AutomationLogFields): AutomationLogFields {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, value]) => {
      if (value === undefined) return [];
      return [[key, secretKeyPattern.test(key) ? "[REDACTED]" : redactValue(value, 0)]];
    }),
  );
}

function redactValue(value: unknown, depth: number): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function")
    return String(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= 4) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      secretKeyPattern.test(key) ? "[REDACTED]" : redactValue(item, depth + 1),
    ]),
  );
}

function formatFieldValue(key: string, value: unknown) {
  if (value instanceof Error)
    return normalizeMessage(parseLegacyMessage(value.message, "system").message);
  if (typeof value === "string") {
    const displayValue = /(?:error|message)$/i.test(key)
      ? normalizeMessage(parseLegacyMessage(value, "system").message)
      : value;
    return displayValue.replace(/\s+/g, " ").slice(0, 500);
  }
  if (typeof value === "number") {
    if (key === "timeoutMinutes") return `${value}m`;
    if (key === "size" || key.endsWith('Bytes')) return formatByteSize(value);
    return /(?:duration|delay|elapsed|interval|timeout).*ms$/i.test(key) || key.endsWith('Ms')
      ? `${value}ms`
      : String(value);
  }
  if (typeof value === "boolean" || value === null) return String(value);
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return normalizeMessage(parseLegacyMessage(message, "system").message)
        .replace(/\s+/g, " ")
        .slice(0, 500);
    }
  }
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function formatByteSize(value: number) {
  if (!Number.isFinite(value) || value < 1_024) return `${value}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  if (value < 1_024 * 1_024 * 1_024) return `${(value / 1_024 / 1_024).toFixed(1)}MB`;
  return `${(value / 1_024 / 1_024 / 1_024).toFixed(1)}GB`;
}

function jsonLogFile(configuredPath: string) {
  return configuredPath.replace(/\.(?:json|jsonl|log)$/i, ".json");
}

type WinstonLogInfo = {
  level: string;
  message: string;
  automationEntry: AutomationLogEntry;
};

type WinstonSink = {
  write(entry: AutomationLogEntry): void;
  flush(): Promise<void>;
};

function getWinstonSink(options: {
  consoleEnabled: boolean;
  logFilePath?: string;
  retentionDays: number;
}) {
  if (!options.consoleEnabled && !options.logFilePath) return undefined;
  const resolvedLogFilePath = options.logFilePath
    ? jsonLogFile(path.resolve(options.logFilePath))
    : undefined;
  const cacheKey = JSON.stringify({
    console: options.consoleEnabled,
    file: resolvedLogFilePath,
    retentionDays: options.retentionDays,
  });
  const cached = winstonSinkCache.get(cacheKey);
  if (cached) return cached;

  const created = createWinstonSink(
    {
      ...options,
      logFilePath: resolvedLogFilePath,
    },
    () => {
      if (winstonSinkCache.get(cacheKey) === created) winstonSinkCache.delete(cacheKey);
    },
  );
  winstonSinkCache.set(cacheKey, created);
  return created;
}

function createWinstonSink(
  options: {
    consoleEnabled: boolean;
    logFilePath?: string;
    retentionDays: number;
  },
  onClose: () => void,
): WinstonSink {
  const outputTransports: WinstonTransport[] = [];

  if (options.consoleEnabled) {
    outputTransports.push(
      new winstonTransports.Console({
        level: "debug",
        format: consoleWinstonFormat(),
      }),
    );
  }

  if (options.logFilePath) {
    const jsonPath = jsonLogFile(options.logFilePath);
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    void cleanupAutomationLogFiles(jsonPath, options.retentionDays).catch(() => undefined);

    const jsonTransport = new winstonTransports.File({
      filename: jsonPath,
      level: "debug",
      format: jsonWinstonFormat(),
    });
    outputTransports.push(jsonTransport);
  }

  const logger = createWinstonLogger({
    level: "debug",
    exitOnError: false,
    transports: outputTransports,
  });
  let closePromise: Promise<void> | undefined;
  let closed = false;
  logger.on("error", () => undefined);

  return {
    write(entry) {
      if (closed) return;
      try {
        logger.log({
          level: entry.level,
          message: entry.message,
          automationEntry: entry,
        });
      } catch {
        // Logging is observational and must never change an automation result.
      }
    },
    async flush() {
      closePromise ??= new Promise<void>((resolve) => {
        const finish = () => {
          closed = true;
          onClose();
          resolve();
        };
        logger.once("finish", finish);
        logger.once("error", finish);
        logger.end();
      });
      await closePromise;
    },
  };
}

function consoleWinstonFormat() {
  return winstonFormat.printf((info) => {
    const entry = (info as unknown as WinstonLogInfo).automationEntry;
    return formatConsoleLogEntry(entry);
  });
}

function jsonWinstonFormat() {
  return winstonFormat.printf((info) => {
    const entry = (info as unknown as WinstonLogInfo).automationEntry;
    return JSON.stringify(entry);
  });
}

export async function cleanupAutomationLogFiles(configuredPath: string, retentionDays = 3) {
  const logDir = path.dirname(jsonLogFile(configuredPath));
  const key = `${logDir}:${formatDateKey()}`;
  if (cleanupKeys.has(key)) return;
  cleanupKeys.add(key);
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1_000;
  await Promise.all(
    [logDir, path.join(logDir, "structured")].map(async (dir, index) => {
      if (index === 0) await mkdir(dir, { recursive: true });
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !/^app(?:-.+)?-\d{4}-\d{2}-\d{2}\.(?:json|jsonl|log)$/i.test(entry.name))
          continue;
        const filePath = path.join(dir, entry.name);
        const fileStat = await stat(filePath).catch(() => undefined);
        if (fileStat && fileStat.mtimeMs < cutoff) await unlink(filePath).catch(() => undefined);
      }
      if (index > 0) {
        const remaining = await readdir(dir).catch(() => ["unavailable"]);
        if (remaining.length === 0) await rm(dir, { recursive: false }).catch(() => undefined);
      }
    }),
  );
}
