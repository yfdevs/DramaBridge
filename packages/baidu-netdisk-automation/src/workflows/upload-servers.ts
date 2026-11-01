/** Accept the client's host strings and compatible server records; restrict destinations carrying session cookies. */
export function baiduUploadServers(response: unknown): string[] {
  const candidates = response && typeof response === "object" && "server" in response
    && Array.isArray(response.server) ? response.server : [];
  const servers: string[] = [];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate
      : candidate && typeof candidate === "object" ? candidate.server : undefined;
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      if (url.protocol !== "https:" || url.port || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash
        || !/(^|\.)(pcs\.baidu\.com|baidupcs\.com)$/.test(url.hostname)) continue;
      if (!servers.includes(url.origin)) servers.push(url.origin);
    } catch { /* Ignore malformed discovery records and retain the client default. */ }
  }
  for (const fallback of ["https://c2.pcs.baidu.com", "https://d.pcs.baidu.com"]) {
    if (!servers.includes(fallback)) servers.push(fallback);
  }
  return servers.slice(0, 3);
}

export function isBaiduUploadTransportError(error: unknown) {
  return /超时|net::ERR_|HTTP (?:408|5\d\d)/i.test(error instanceof Error ? error.message : String(error));
}
