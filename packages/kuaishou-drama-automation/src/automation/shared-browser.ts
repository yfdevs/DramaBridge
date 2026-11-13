import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import type { BrowserContext, Page } from "playwright";

type Entry = {
  context: BrowserContext;
  users: number;
  closed: boolean;
  closing?: Promise<void>;
  credentialStatePath?: string;
  flush: () => Promise<void>;
  dispose: () => void;
};
const sessions = new Map<string, Promise<Entry>>();
const writes = new Map<string, Promise<void>>();

/** Credentials are runtime artifacts, written atomically and serially per account. */
export async function persistKuaishouCredentials(context: BrowserContext, file: string) {
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const state = await context.storageState({ indexedDB: true });
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  });
  writes.set(file, next);
  try { await next; } finally { if (writes.get(file) === next) writes.delete(file); }
}

/** One persistent profile per account; each caller owns only its own tabs. */
export async function openKuaishouBrowserContext(userDataDir: string, options: {
  credentialStatePath?: string;
  headless?: boolean;
  slowMo?: number;
  channel?: string;
  onError?: (error: unknown) => void;
} = {}): Promise<BrowserContext> {
  const absolute = path.resolve(userDataDir);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  for (;;) {
    let pending = sessions.get(key);
    if (!pending) {
      pending = (async (): Promise<Entry> => {
        const context = await launchPlatformBrowserContext(absolute, { headless: options.headless ?? false, slowMo: options.slowMo ?? 0, channel: options.channel });
        try {
          // Migrate older snapshot-only sessions without replacing a populated profile.
          if (options.credentialStatePath) {
            const stored = await readFile(options.credentialStatePath, "utf8").catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw error;
            });
            if (stored) {
              const snapshot = JSON.parse(stored) as Awaited<ReturnType<BrowserContext["storageState"]>>;
              const current = await context.cookies();
              if (!current.length) await context.setStorageState(snapshot);
              else {
                // Chromium can discard session cookies on restart while retaining
                // analytics cookies. Restore missing cookies without undoing a newer login.
                const identity = (cookie: { name: string; domain: string; path: string }) => JSON.stringify([cookie.domain, cookie.path, cookie.name]);
                const present = new Set(current.map(identity));
                await context.addCookies(snapshot.cookies.filter(cookie => !present.has(identity(cookie)) && (cookie.expires < 0 || cookie.expires > Date.now() / 1000)));
                await context.addInitScript(origins => {
                  const saved = origins.find(item => item.origin === location.origin);
                  for (const item of saved?.localStorage ?? []) if (localStorage.getItem(item.name) === null) localStorage.setItem(item.name, item.value);
                }, snapshot.origins);
              }
            }
          }
          const entry: Entry = { context, users: 0, closed: false, credentialStatePath: options.credentialStatePath,
            flush: async () => { if (entry.credentialStatePath && !entry.closed) await persistKuaishouCredentials(context, entry.credentialStatePath); },
            dispose: () => undefined };
          let saving: Promise<void> | undefined;
          const save = () => {
            if (entry.closed || saving) return;
            saving = entry.flush().catch(error => options.onError?.(error)).finally(() => { saving = undefined; });
          };
          const navigations = new Map<Page, () => void>();
          const watch = (page: Page) => {
            const navigation = () => save();
            page.on("framenavigated", navigation);
            navigations.set(page, navigation);
            page.once("close", () => navigations.delete(page));
          };
          context.pages().forEach(watch);
          context.on("page", watch);
          const timer = setInterval(save, 3000);
          timer.unref();
          entry.dispose = () => {
            clearInterval(timer);
            context.off("page", watch);
            for (const [page, listener] of navigations) page.off("framenavigated", listener);
            navigations.clear();
          };
          context.once("close", () => {
            entry.closed = true;
            entry.dispose();
            if (sessions.get(key) === pending) sessions.delete(key);
          });
          return entry;
        } catch (error) { await context.close().catch(() => undefined); throw error; }
      })();
      sessions.set(key, pending);
    }
    let entry: Entry;
    try { entry = await pending; }
    catch (error) { if (sessions.get(key) === pending) sessions.delete(key); throw error; }
    if (entry.closing) { await entry.closing; continue; }
    if (entry.closed) { if (sessions.get(key) === pending) sessions.delete(key); continue; }
    if (options.credentialStatePath && entry.credentialStatePath && path.resolve(options.credentialStatePath) !== path.resolve(entry.credentialStatePath))
      throw new Error("同一快手浏览器目录配置了不同的账号凭证文件，请检查账号配置");
    entry.credentialStatePath ??= options.credentialStatePath;
    const pages = new Set<Page>(entry.users === 0 ? entry.context.pages() : []);
    entry.users++;
    let closing: Promise<void> | undefined;
    const listeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
    const close = () => closing ??= (async () => {
      for (const { event, listener } of listeners) entry.context.off(event as "close", listener);
      entry.users--;
      if (entry.users === 0 && !entry.closed) {
        entry.closing = (async () => {
          entry.dispose();
          // Chromium may clear session cookies as the final page closes. The
          // last snapshot must be captured before closing pages, never after.
          try { await entry.flush(); }
          finally {
            await Promise.all([...pages].map(page => page.close().catch(() => undefined)));
            await entry.context.close();
          }
        })();
        await entry.closing;
      } else {
        try { await entry.flush(); } catch (error) { options.onError?.(error); }
        await Promise.all([...pages].map(page => page.close().catch(() => undefined)));
      }
    })();
    const scoped = new Proxy(entry.context, {
      get(target, property) {
        if (property === "close") return close;
        if (property === "pages") return () => [...pages].filter(page => !page.isClosed());
        if (property === "newPage") return async () => {
          if (closing) throw new Error("快手浏览器会话已停止");
          const page = await target.newPage(); pages.add(page);
          page.once("close", () => pages.delete(page));
          return page;
        };
        if (property === "on" || property === "once") return (event: string, listener: (...args: any[]) => void) => {
          listeners.push({ event, listener }); target[property](event as "close", listener); return scoped;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return scoped;
  }
}
