/** Normalize plain and Baidu web API obfuscated MD5 values before comparing content.
 * Format reference: https://github.com/qjfoidnh/BaiduPCS-Go/blob/master/baidupcs/util.go#L134
 */
export function normalizeBaiduMd5(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const encoded = value.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(encoded)) return encoded;
  if (encoded.length !== 32) return;
  const marker = encoded.charCodeAt(9) - "g".charCodeAt(0);
  if (marker < 0 || marker > 15) return;
  const restored = encoded.slice(0, 9) + marker.toString(16) + encoded.slice(10);
  if (!/^[0-9a-f-]{32}$/.test(restored)) return;
  const decoded = Array.from(restored, (char, index) =>
    ((char === "-" ? 0 : Number.parseInt(char, 16)) ^ (index & 15)).toString(16),
  ).join("");
  return decoded.slice(8, 16) + decoded.slice(0, 8) + decoded.slice(24, 32) + decoded.slice(16, 24);
}
