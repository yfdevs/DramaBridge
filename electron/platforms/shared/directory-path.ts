import path from "node:path";

export function normalizeRuntimeDirectory(value: string, platform = process.platform) {
  if (platform === "win32" || !path.win32.isAbsolute(value)) return value;
  // Older platform defaults were Windows-only, even on macOS. Recover those
  // defaults, but require an explicit selection for other foreign paths.
  const legacy = /^[a-z]:[\\/]\.drama-runs[\\/]([^\\/]+)[\\/]?$/i.exec(value);
  if (legacy) return `.drama-runs/${legacy[1]}`;
  if (path.isAbsolute(value) && !value.startsWith("\\")) return value;
  throw new Error(`当前系统无法使用 Windows 目录：${value}。请在配置中重新选择目录`);
}
