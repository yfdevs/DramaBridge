import { Data } from "effect";

export type BaiduNetdiskWorkflowStage =
  | "input"
  | "filesystem"
  | "cdp"
  | "share-navigation"
  | "share-extraction"
  | "share-transfer"
  | "download-submission";

type ErrorDetails = {
  readonly message: string;
  readonly cause?: unknown;
};

export class UnsupportedPlatformError extends Data.TaggedError("UnsupportedPlatformError")<
  ErrorDetails & { readonly platform: NodeJS.Platform }
> {}

export class InvalidShareInputError extends Data.TaggedError("InvalidShareInputError")<ErrorDetails> {}

export class BaiduNetdiskFileSystemError extends Data.TaggedError("BaiduNetdiskFileSystemError")<
  ErrorDetails & { readonly path: string }
> {}

export class CdpConnectionError extends Data.TaggedError("CdpConnectionError")<
  ErrorDetails & { readonly port?: number }
> {}

export class CdpTimeoutError extends Data.TaggedError("CdpTimeoutError")<
  ErrorDetails & { readonly operation: string; readonly timeoutMs: number }
> {}

export class ShareNavigationError extends Data.TaggedError("ShareNavigationError")<ErrorDetails> {}

export class ShareExtractionError extends Data.TaggedError("ShareExtractionError")<ErrorDetails> {}

export class ShareTransferError extends Data.TaggedError("ShareTransferError")<ErrorDetails> {}

export class DownloadSubmissionError extends Data.TaggedError("DownloadSubmissionError")<ErrorDetails> {}

export type RemoteMaterialKind =
  | "episode"
  | "ownership-images"
  | "ownership-files"
  | "poster"
  | "ai-production-proof"
  | "metadata-text";

export class RemoteMaterialValidationError extends Data.TaggedError("RemoteMaterialValidationError")<
  ErrorDetails & {
    readonly material: RemoteMaterialKind;
    readonly expected: number;
    readonly actual: number;
  }
> {}

export type BaiduNetdiskAutomationError =
  | UnsupportedPlatformError
  | InvalidShareInputError
  | BaiduNetdiskFileSystemError
  | CdpConnectionError
  | CdpTimeoutError
  | ShareNavigationError
  | ShareExtractionError
  | ShareTransferError
  | DownloadSubmissionError
  | RemoteMaterialValidationError;

const errorTags = new Set<BaiduNetdiskAutomationError["_tag"]>([
  "UnsupportedPlatformError",
  "InvalidShareInputError",
  "BaiduNetdiskFileSystemError",
  "CdpConnectionError",
  "CdpTimeoutError",
  "ShareNavigationError",
  "ShareExtractionError",
  "ShareTransferError",
  "DownloadSubmissionError",
  "RemoteMaterialValidationError",
]);

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isBaiduNetdiskAutomationError(
  error: unknown,
): error is BaiduNetdiskAutomationError {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  return errorTags.has((error as { _tag: BaiduNetdiskAutomationError["_tag"] })._tag);
}

export function cdpConnectionError(error: unknown, port?: number): CdpConnectionError {
  if (
    error
    && typeof error === "object"
    && "_tag" in error
    && error._tag === "CdpConnectionError"
  ) {
    return error as CdpConnectionError;
  }
  return new CdpConnectionError({ message: errorMessage(error), cause: error, port });
}

export function classifyBaiduNetdiskAutomationError(
  error: unknown,
  fallbackStage: BaiduNetdiskWorkflowStage = "download-submission",
): BaiduNetdiskAutomationError {
  if (isBaiduNetdiskAutomationError(error)) return error;
  const message = errorMessage(error);
  const details = { message, cause: error };

  if (/只支持 Windows|当前支持 Windows 和 macOS|当前不是 Windows/.test(message)) {
    return new UnsupportedPlatformError({
      ...details,
      platform: process.platform,
    });
  }
  if (/必须提供 shareText|分享文本|分享链接|提取码/.test(message) && /没有找到|必须提供|解析/.test(message)) {
    return new InvalidShareInputError(details);
  }
  if (/验证码|提取码错误|密码错误|分享不存在|分享已取消|分享已过期|分享链接不可用|分享(?:的)?文件(?:已经|已)(?:被删除|过期)|没有进入分享文件列表/.test(message)) {
    return new ShareExtractionError(details);
  }
  if (/CDP|WebSocket|目标页面|页面已关闭|没有找到可导航/.test(message)) {
    return new CdpConnectionError(details);
  }

  switch (fallbackStage) {
    case "input":
      return new InvalidShareInputError(details);
    case "filesystem":
      return new BaiduNetdiskFileSystemError({ ...details, path: "" });
    case "cdp":
      return new CdpConnectionError(details);
    case "share-navigation":
      return new ShareNavigationError(details);
    case "share-extraction":
      return new ShareExtractionError(details);
    case "share-transfer":
      return new ShareTransferError(details);
    case "download-submission":
      return new DownloadSubmissionError(details);
  }
}
