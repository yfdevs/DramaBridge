import path from "node:path";
import { mkdir, lstat, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { launchPlatformBrowserContext } from "@dramabridge/browser-window";

export type YoutubeBrowserCredential = {
  channelId: string;
  savedAt: string;
  checkedAt?: string;
  needsLogin?: boolean;
  source?: "browser" | "cookies";
  profileId?: string;
  connectionKey?: string;
};
export type YoutubeBrowserStatus = {
  saved: boolean;
  busy: boolean;
  channelId?: string;
  savedAt?: string;
  checkedAt?: string;
  needsLogin?: boolean;
  source?: "browser" | "cookies";
  profileId?: string;
};
export type YoutubeBrowserOptions = {
  directory: string;
  proxy: string;
  read: (accountId: string) => YoutubeBrowserCredential | undefined;
  write: (accountId: string, value: YoutubeBrowserCredential | undefined) => void;
  all: () => Record<string, YoutubeBrowserCredential>;
  beforeLaunch?: () => void;
  launch?: typeof launchPlatformBrowserContext;
};
type BrowserEntry = { context: BrowserContext; page: Page; busy: boolean; connectionKey: string };

async function verifyStudioChannel(page: Page, channelId: string) {
  // Check the channel in the loaded navigation, not just the requested URL.
  await page
    .locator(
      `[href="/channel/${channelId}/videos/upload"],[href="https://studio.youtube.com/channel/${channelId}/videos/upload"]`,
    )
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForStudioLogin(page: Page) {
  await page.waitForURL(
    (url) =>
      Boolean(studioChannelId(url.href)) ||
      url.hostname === "accounts.google.com" ||
      url.hostname === "consent.google.com" ||
      url.hostname === "www.youtube.com",
    { timeout: 30_000 },
  );
}

export function youtubeAccountId(value: string) {
  if (!/^(?:default|[a-f0-9]{32})$/.test(value)) throw new Error("无效的 YouTube 账号");
  return value;
}
export function youtubeVideoEditUrl(videoId: string) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("无效的 YouTube 视频编号");
  return `https://studio.youtube.com/video/${videoId}/edit`;
}
export function studioChannelId(url: string) {
  const parsed = new URL(url);
  return parsed.origin === "https://studio.youtube.com"
    ? /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(parsed.pathname)?.[1]
    : undefined;
}

/** Full Chromium profiles retain HttpOnly cookies, browser storage and cookie rotations. */
export class YoutubeBrowserSessions {
  private entries = new Map<string, BrowserEntry>();
  private opening = new Set<string>();
  private operations = new Set<string>();
  private pending = new Map<string, string>();

  private profile(accountId: string) {
    youtubeAccountId(accountId);
    return youtubeAccountId(
      this.pending.get(accountId) ?? this.options().read(accountId)?.profileId ?? accountId,
    );
  }

  private connectionKey() {
    return createHash("sha256").update(this.options().proxy.trim()).digest("hex");
  }

  private credential(accountId: string) {
    const value = this.options().read(youtubeAccountId(accountId));
    if (!value || value.source !== "browser")
      throw new Error("请先在账号管理完成浏览器登录并确认保存");
    if (value.connectionKey !== this.connectionKey())
      throw new Error("代理设置已改变，请恢复登录时的代理后继续，避免切换登录网络");
    return value;
  }

  private async exclusive<T>(accountId: string, operation: () => Promise<T>) {
    const profileId = this.profile(accountId);
    if (this.operations.has(profileId) || this.opening.has(profileId))
      throw new Error("同一 Google 登录正在执行操作，请等待完成后重试");
    this.operations.add(profileId);
    try {
      return await operation();
    } finally {
      this.operations.delete(profileId);
    }
  }
  private async taskOperation<T>(
    accountId: string,
    assertActive: () => Promise<void>,
    operation: () => Promise<T>,
  ) {
    const profileId = this.profile(accountId);
    while (true) {
      await assertActive();
      if (this.profile(accountId) !== profileId)
        throw new Error("任务使用的浏览器登录已改变，请重新检查账号");
      if (!this.operations.has(profileId) && !this.opening.has(profileId))
        return this.exclusive(accountId, operation);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  constructor(private readonly options: () => YoutubeBrowserOptions) {}

  status(accountId: string): YoutubeBrowserStatus {
    youtubeAccountId(accountId);
    const credential = this.options().read(accountId);
    const profileId = this.profile(accountId);
    const entry = this.entries.get(profileId);
    return {
      channelId: credential?.channelId,
      savedAt: credential?.savedAt,
      checkedAt: credential?.checkedAt,
      source: credential?.source,
      saved: credential?.source === "browser",
      busy: this.opening.has(profileId) || this.operations.has(profileId) || (entry?.busy ?? false),
      needsLogin: credential?.source !== "browser" || credential?.needsLogin,
      profileId,
    };
  }

  private async open(accountId: string) {
    accountId = this.profile(accountId);
    if (this.opening.has(accountId)) throw new Error("该账号的浏览器正在启动");
    const existing = this.entries.get(accountId);
    if (existing) {
      if (existing.connectionKey !== this.connectionKey())
        throw new Error("代理设置已改变，请恢复登录时的代理后继续");
      if (existing.page.isClosed()) existing.page = await existing.context.newPage();
      if (existing.busy) throw new Error("该账号的浏览器正在执行任务，请稍后再试");
      return existing;
    }
    this.opening.add(accountId);
    try {
      const options = this.options();
      const connectionKey = this.connectionKey();
      const directory = path.join(options.directory, accountId);
      await mkdir(directory, { recursive: true });
      options.beforeLaunch?.();
      const context = await (options.launch ?? launchPlatformBrowserContext)(directory, {
        // Keep one installed Chrome profile for both manual login and automation.
        channel: "chrome",
        headless: false,
        ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
      });
      const page = context.pages()[0] ?? (await context.newPage());
      const entry = { context, page, busy: false, connectionKey };
      this.entries.set(accountId, entry);
      context.on("close", () => {
        if (this.entries.get(accountId) === entry) this.entries.delete(accountId);
      });
      return entry;
    } finally {
      this.opening.delete(accountId);
    }
  }

  async start(accountId: string, reuseAccountId?: string) {
    youtubeAccountId(accountId);
    const existing = this.options().read(accountId);
    if (existing && existing.source !== "browser")
      throw new Error("旧 Cookie 授权已停用，请先清除旧授权，再用浏览器登录");
    if (existing) this.credential(accountId);
    const profileId = reuseAccountId
      ? this.profile(youtubeAccountId(reuseAccountId))
      : this.profile(accountId);
    if (reuseAccountId) this.credential(reuseAccountId);
    if (existing && (existing.profileId ?? accountId) !== profileId)
      throw new Error("已绑定登录不能直接替换，请先清除网页授权");
    if ([...this.pending].some(([id, profile]) => id !== accountId && profile === profileId))
      throw new Error("该 Google 登录正在为其他频道确认登录，请先完成或取消");
    this.pending.set(accountId, profileId);
    try {
      return await this.exclusive(accountId, async () => {
        const entry = await this.open(accountId);
        await entry.page.goto(
          existing
            ? `https://studio.youtube.com/channel/${existing.channelId}`
            : "https://www.youtube.com/channel_switcher",
          { waitUntil: "domcontentloaded", timeout: 60_000 },
        );
        await entry.page.bringToFront();
        return this.status(accountId);
      });
    } catch (error) {
      this.pending.delete(accountId);
      throw error;
    }
  }

  async save(accountId: string) {
    return this.exclusive(accountId, async () => {
      const profileId = this.pending.get(accountId);
      if (!profileId) throw new Error("请先打开登录浏览器");
      const entry = this.entries.get(profileId);
      if (!entry) throw new Error("登录浏览器已关闭，请重新打开");
      if (entry.connectionKey !== this.connectionKey())
        throw new Error("代理设置已改变，请恢复打开登录浏览器时的代理后再保存");
      const studioPages = entry.context
        .pages()
        .filter((page) => Boolean(studioChannelId(page.url())));
      if (studioPages.length !== 1)
        throw new Error("请只保留一个目标频道的 Studio 页面，再确认保存");
      entry.page = studioPages[0]!;
      const channelId = studioChannelId(entry.page.url());
      if (!channelId)
        throw new Error("请在打开的浏览器完成登录、选择频道并进入 YouTube Studio 后，再确认保存");
      const previous = this.options().read(accountId);
      if (previous && previous.channelId !== channelId)
        throw new Error("当前频道与已绑定频道不同，请切换回原频道");
      await verifyStudioChannel(entry.page, channelId);
      if (entry.connectionKey !== this.connectionKey())
        throw new Error("代理设置已改变，请恢复打开登录浏览器时的代理后再保存");
      const now = new Date().toISOString();
      this.options().write(accountId, {
        channelId,
        profileId,
        connectionKey: entry.connectionKey,
        source: "browser",
        savedAt: previous?.savedAt ?? now,
        checkedAt: now,
        needsLogin: false,
      });
      this.pending.delete(accountId);
      return this.status(accountId);
    });
  }

  async cancel(accountId: string) {
    if (!this.options().read(youtubeAccountId(accountId))) return this.forget(accountId);
    return this.exclusive(accountId, async () => {
      this.pending.delete(accountId);
    });
  }

  async check(accountId: string, assertActive?: () => Promise<void>) {
    if (assertActive)
      return this.taskOperation(accountId, assertActive, () =>
        this.checkSession(accountId, assertActive),
      );
    return this.exclusive(accountId, () => this.checkSession(accountId, async () => {}));
  }

  private async checkSession(accountId: string, assertActive: () => Promise<void>) {
    const credential = this.credential(accountId);
    if ([...this.pending.values()].includes(this.profile(accountId)))
      throw new Error("请先完成或取消浏览器登录确认");
    const entry = await this.open(accountId);
    entry.busy = true;
    try {
      await assertActive();
      // Studio's root follows the Google account's last-selected channel, which
      // may differ from the channel this task is bound to.
      await entry.page.goto(`https://studio.youtube.com/channel/${credential.channelId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitForStudioLogin(entry.page);
      const channelId = studioChannelId(entry.page.url());
      if (!channelId) {
        this.options().write(accountId, { ...credential, needsLogin: true });
        throw new Error("浏览器登录已失效，请打开登录浏览器，手动完成 Google 验证后确认保存");
      }
      if (channelId !== credential.channelId)
        throw new Error("未能进入已绑定频道，请确认当前 Google 账号有该频道的管理权限");
      await verifyStudioChannel(entry.page, channelId);
      await assertActive();
      this.options().write(accountId, {
        ...credential,
        checkedAt: new Date().toISOString(),
        needsLogin: false,
      });
      return this.status(accountId);
    } finally {
      entry.busy = false;
    }
  }

  async withVideo(
    accountId: string,
    videoId: string,
    assertActive: () => Promise<void>,
    edit: (page: Page, assertActive: () => Promise<void>) => Promise<void>,
  ) {
    const url = youtubeVideoEditUrl(videoId);
    youtubeAccountId(accountId);
    return this.taskOperation(accountId, assertActive, async () => {
      await this.checkSession(accountId, assertActive);
      const entry = await this.open(accountId);
      entry.busy = true;
      try {
        const page = await entry.context.newPage();
        await assertActive();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await verifyStudioChannel(page, this.credential(accountId).channelId);
        await edit(page, async () => {
          await assertActive();
          this.credential(accountId);
        });
        await assertActive();
        await page.close();
      } finally {
        // A failed task page stays open so the user can inspect or repair it.
        entry.busy = false;
      }
    });
  }

  async forget(accountId: string) {
    return this.exclusive(accountId, async () => {
      const profileId = this.profile(accountId);
      if ([...this.pending].some(([id, profile]) => id !== accountId && profile === profileId))
        throw new Error("请先完成其他频道的浏览器登录确认");
      const shared = Object.entries(this.options().all()).some(
        ([id, value]) => id !== accountId && (value.profileId ?? id) === profileId,
      );
      if (!shared) {
        await this.entries.get(profileId)?.context.close();
        const root = path.resolve(this.options().directory);
        const target = path.resolve(root, profileId);
        const info = await lstat(target).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        });
        if (info) {
          if (
            info.isSymbolicLink() ||
            path.relative(await realpath(root), await realpath(target)) !== profileId
          )
            throw new Error("浏览器目录不安全，停止清理");
          await rm(target, { recursive: true, force: false });
        }
      }
      this.pending.delete(accountId);
      this.options().write(accountId, undefined);
    });
  }

  async close() {
    this.pending.clear();
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.context.close()));
  }
}
