import { setTimeout as delay } from "node:timers/promises";

export const BAIDU_RISK_CONTROL_MARKER = "[BAIDU_NETDISK_RISK_CONTROL]";
export const BAIDU_IDENTITY_VERIFICATION_MARKER = "[BAIDU_NETDISK_IDENTITY_VERIFICATION]";
const verificationCodes = new Set([8001, 8011, 80331, 80332, 80333, 8041, 8042, 8043, 8045, 8046, 8047, 8048, 8049, 8050, 8055, 8056, 8057]);
const frequencyCodes = new Set([110, 9002, 31034]);

export function baiduApiError(result: Record<string, unknown>, endpoint: string): Error | undefined {
  const code = Number(result.errno ?? result.error_code ?? 0);
  if (code === 0) return undefined;
  const requestId = String(result.request_id ?? result.requestid ?? "").replace(/[^\w-]/g, "").slice(0, 100);
  // Do not include response bodies, URLs, cookies, upload signatures or tokens.
  const detail = `errno=${code}${requestId ? ` request_id=${requestId}` : ""} endpoint=${endpoint}`;
  if (code === 132) {
    // The installed client routes this to deleteFileSecurity. This operation
    // requires verification; it is not evidence that reads/uploads are blocked.
    return new Error(`${BAIDU_IDENTITY_VERIFICATION_MARKER} ${detail}；百度网盘要求验证身份后才能删除或管理文件。请在百度客户端完成身份验证后重试此操作；已保留本地文件和已上传内容，不会自动重试，也不会暂停其他上传。`);
  }
  if (verificationCodes.has(code) || frequencyCodes.has(code)) {
    return new Error(`${BAIDU_RISK_CONTROL_MARKER} ${detail}；百度网盘要求验证或操作过于频繁，已暂停自动请求。请在客户端完成验证，稍后手动重试。`);
  }
  const message = String(result.errmsg ?? result.error_msg ?? result.show_msg ?? "百度接口返回异常").slice(0, 200);
  return new Error(`百度网盘接口失败：${detail}；${message}`);
}

/** Separate pacing for metadata and bounded bulk transfers, sharing one risk circuit. */
export function createBaiduRequestGate(intervalMs = 400, cooldownMs = 60_000, dataIntervalMs = 20) {
  const nextStart = { metadata: 0, data: 0 };
  let blockedUntil = 0;
  return {
    async acquire(signal?: AbortSignal, traffic: "metadata" | "data" = "metadata") {
      signal?.throwIfAborted();
      if (Date.now() < blockedUntil) throw new Error(`${BAIDU_RISK_CONTROL_MARKER} 百度网盘自动操作暂停中，请完成客户端验证后稍后重试。`);
      const start = Math.max(Date.now(), nextStart[traffic]);
      nextStart[traffic] = start + (traffic === "data" ? dataIntervalMs : intervalMs);
      if (start > Date.now()) {
        try { await delay(start - Date.now(), undefined, { signal }); }
        catch (error) { signal?.throwIfAborted(); throw error; }
      }
      signal?.throwIfAborted();
      if (Date.now() < blockedUntil) throw new Error(`${BAIDU_RISK_CONTROL_MARKER} 百度网盘自动操作暂停中，请完成客户端验证后稍后重试。`);
    },
    observe(error: unknown) {
      if (String(error).includes(BAIDU_RISK_CONTROL_MARKER)) blockedUntil = Date.now() + cooldownMs;
    },
  };
}

export const baiduUploadRequestGate = createBaiduRequestGate();
