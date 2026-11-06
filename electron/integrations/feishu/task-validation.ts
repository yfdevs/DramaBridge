import type { RecreationInput } from "../../../src/platforms/feishu/task-types";

// Spreadsheet titles may contain formatting line breaks and platform notes.
export function normalizeRecreationTitle(value: string) {
  return value
    .replace(/[（(]\s*抖音上架剧名\s*[）)]\s*$/, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

// Names are used unchanged on Windows and in Baidu Netdisk, so reject lossy names.
export function validateRecreationTitle(value: string) {
  if (
    !value ||
    value.length > 80 ||
    /[<>:"/\\|?*]/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("剧名须为 1–80 字，不能包含路径或 Windows 文件名禁用字符");
  }
}

export function validateRecreationInput(input: RecreationInput) {
  validateRecreationTitle(input.originalTitle);
  if (
    !Number.isSafeInteger(input.episodeCount) ||
    input.episodeCount < 1 ||
    input.episodeCount > 10000
  )
    throw new Error("集数须为 1–10000 的整数");
  if (!/https:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/.test(input.shareText))
    throw new Error("百度链接须包含有效的 pan.baidu.com/s/ 分享链接，可附提取码");
  input.versions.forEach(validateRecreationTitle);
  const titles = [input.originalTitle, ...input.versions].map((title) => title.toLocaleLowerCase());
  if (new Set(titles).size !== titles.length)
    throw new Error("版本名称不能重复，也不能与原剧名相同");
}
