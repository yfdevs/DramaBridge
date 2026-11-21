export function isBaiduFileRenderer(target: { url: string; webSocketDebuggerUrl?: string }) {
  if (!target.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "file:" && /\/core\.asar\/index\.html$/i.test(url.pathname);
  } catch { return false; }
}

export function isBaiduMainFileTarget(target: { url: string; webSocketDebuggerUrl?: string; windowId?: number; mainWindowId?: number }) {
  return isBaiduFileRenderer(target) && Number.isSafeInteger(target.windowId) && target.windowId! > 0 && target.windowId === target.mainWindowId;
}
