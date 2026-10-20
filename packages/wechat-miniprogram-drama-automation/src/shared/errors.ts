import { formatAutomationErrorReport } from "@dramabridge/automation-logging";

export enum ErrorType {
  Unknown = "UNKNOWN",
  Configuration = "CONFIGURATION",
  ApiRequest = "API_REQUEST",
  ApiResponse = "API_RESPONSE",
  Authentication = "AUTHENTICATION",
  ChannelState = "CHANNEL_STATE",
  TaskClaim = "TASK_CLAIM",
  TaskExecution = "TASK_EXECUTION",
  StepTimeout = "STEP_TIMEOUT",
  Validation = "VALIDATION",
  Upload = "UPLOAD",
  LocalFile = "LOCAL_FILE",
  Browser = "BROWSER",
  Interrupted = "INTERRUPTED",
}

export type RpaFailStage =
  | "LOGIN"
  | "FILL_FORM"
  | "UPLOAD_FILE"
  | "SUBMIT"
  | "RECOGNIZE_RESULT"
  | "OTHER";

export interface StandardErrorInfo {
  type: ErrorType;
  name: string;
  message: string;
  stack?: string;
  failStage?: RpaFailStage;
}

const errorTypeRules: Array<[ErrorType, RegExp]> = [
  [
    ErrorType.Interrupted,
    /Target (?:page, context or browser|page|context|browser) has been closed|Target closed|(?:page|context|browser) (?:has been|was) closed/i,
  ],
  [ErrorType.StepTimeout, /\[step-timeout\]|timeout|timed out/i],
  [ErrorType.Upload, /\[upload-failed\]|upload|上传|未能上传/i],
  [
    ErrorType.LocalFile,
    /\[local-video-invalid\]|\[production-proof-invalid\]|\[ai-production-proof-invalid\]|\[poster-material-invalid\]|file not found|directory|目录不存在|本地文件/i,
  ],
  [ErrorType.Validation, /validation|invalid|required|must|empty|校验|提示|不能为空|不存在/i],
  [ErrorType.Authentication, /login|required login|登录|scan|扫码/i],
  [ErrorType.ChannelState, /Unknown channelId|Channel is|reserved|busy|video account/i],
  [ErrorType.TaskClaim, /claim task|claim loop|account task page|领取/i],
  [
    ErrorType.Browser,
    /\[ai-content-switch-failed\]|browser|page|locator|playwright|chromium|context/i,
  ],
  [
    ErrorType.ApiRequest,
    /HTTP\s+\d{3}|\b(?:ECONN\w*|ETIMEDOUT|ENOTFOUND)\b|\bAxios(?:Error)?\b|\bREQUEST\b|\b(?:POST|GET|PUT|DELETE|PATCH)\s+(?:https?:\/\/|\/)/i,
  ],
  [ErrorType.ApiResponse, /response data|payloadJson|code=\d+|接口|响应/i],
  [ErrorType.Configuration, /config|ENV|apiBaseUrl|localEpisodeVideoRoot/i],
];

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function humanTimeout(timeoutMs: string): string {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return "限定时间";
  if (parsed % 60000 === 0) return `${Math.round(parsed / 60000)}分钟`;
  if (parsed % 1000 === 0) return `${Math.round(parsed / 1000)}秒`;
  return `${parsed}毫秒`;
}

function publicPlaywrightTimeoutMessage(
  message: string,
  failStage?: RpaFailStage,
): string | undefined {
  const compact = message.replace(/\s+/g, " ").trim();
  const waitForUrlTimeout = compact.match(/(?:page\.)?waitForURL:\s*Timeout\s+(\d+)ms\s+exceeded/i);
  if (waitForUrlTimeout) {
    const duration = humanTimeout(waitForUrlTimeout[1]);
    if (failStage === "LOGIN") {
      return "微信小程序需要登录，请先完成扫码登录后重试。";
    }
    return `等待页面跳转超时：${duration}内页面没有进入目标地址，请检查当前页面是否卡住或网络是否异常。`;
  }

  const navigationTimeout = compact.match(
    /Timeout\s+(\d+)ms\s+exceeded.*waiting for navigation until ["']?([^"']+)["']?/i,
  );
  if (navigationTimeout) {
    return `等待页面加载完成超时：${humanTimeout(navigationTimeout[1])}内页面未完成加载，请检查网络或重新打开页面后重试。`;
  }

  const locatorTimeout = compact.match(
    /locator\.(click|waitFor|fill|check|setInputFiles):\s*Timeout\s+(\d+)ms\s+exceeded/i,
  );
  if (locatorTimeout) {
    return `页面控件操作超时：${humanTimeout(locatorTimeout[2])}内未能完成目标控件操作，请检查页面是否卡住或控件是否变化。`;
  }

  return undefined;
}

function publicErrorMessage(error: unknown, message: string, failStage?: RpaFailStage): string {
  const playwrightTimeoutMessage = publicPlaywrightTimeoutMessage(message, failStage);
  if (playwrightTimeoutMessage) return playwrightTimeoutMessage;
  return formatAutomationErrorReport(error);
}

function extractName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

export function classifyError(error: unknown, fallbackType = ErrorType.Unknown): StandardErrorInfo {
  const rawMessage = extractMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const typedError = error as { errorType?: unknown; failStage?: unknown; type?: unknown };
  const explicitType = typedError.errorType ?? typedError.type;
  const failStage =
    typeof typedError.failStage === "string" && isRpaFailStage(typedError.failStage)
      ? typedError.failStage
      : undefined;
  const message = publicErrorMessage(error, rawMessage, failStage);

  if (
    typeof explicitType === "string" &&
    Object.values(ErrorType).includes(explicitType as ErrorType)
  ) {
    return {
      type: explicitType as ErrorType,
      name: extractName(error),
      message,
      stack,
      failStage,
    };
  }

  const matchedRule = errorTypeRules.find(
    ([, pattern]) => pattern.test(rawMessage) || pattern.test(message),
  );
  return {
    type: matchedRule?.[0] ?? fallbackType,
    name: extractName(error),
    message,
    stack,
    failStage,
  };
}

export function getErrorMessage(error: unknown): string {
  return extractMessage(error);
}

export function isRpaFailStage(value: string): value is RpaFailStage {
  return ["LOGIN", "FILL_FORM", "UPLOAD_FILE", "SUBMIT", "RECOGNIZE_RESULT", "OTHER"].includes(
    value,
  );
}

export function attachFailStage(error: unknown, failStage: RpaFailStage): Error {
  if (error instanceof Error) {
    Object.assign(error, { failStage });
    return error;
  }

  return Object.assign(new Error(String(error)), { failStage });
}

export function inferRpaFailStage(
  errorType: ErrorType,
  explicitFailStage?: RpaFailStage,
): RpaFailStage {
  if (explicitFailStage) return explicitFailStage;
  switch (errorType) {
    case ErrorType.Authentication:
      return "LOGIN";
    case ErrorType.Upload:
    case ErrorType.LocalFile:
      return "UPLOAD_FILE";
    case ErrorType.Validation:
      return "FILL_FORM";
    default:
      return "OTHER";
  }
}
