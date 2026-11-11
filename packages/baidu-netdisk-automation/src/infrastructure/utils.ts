import { requestTimeoutMs } from "../domain/constants.js";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function getArg(args: string[], name: string) {
  const equalArg = args.find((arg) => arg.startsWith(`${name}=`));
  if (equalArg) return equalArg.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

export function numberArg(args: string[], name: string) {
  const value = getArg(args, name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是数字`);
  return parsed;
}

export function formatByteSize(bytes: number | undefined) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex <= 1 || size >= 100 ? 0 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

export function websocketDataToString(data: unknown) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((item) =>
        Buffer.isBuffer(item) ? item : Buffer.from(item as ArrayBuffer),
      ),
    ).toString("utf8");
  }

  return String(data);
}

export async function getJson<T>(url: string, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
