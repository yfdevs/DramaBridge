import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { resolveFromRoot, type ServiceConfig } from "../shared/config.js";
import type { UpdateCredentialsRequest } from "../shared/types.js";
import { FeishuNotifier } from "@dramabridge/feishu-notifier";
import type { VideoAccount } from "../api/video-accounts.js";
import { loginQrCodeSelector, nativeDramaListUrl, playletUrl } from "./constants.js";
import { waitForLoginIfNeeded } from "./browser-session.js";
import { createLogger, runWithLogContext } from "../shared/logger.js";

const browserLogger = createLogger("browser");

interface ManagedChannel {
  context: BrowserContext;
  userDataDir: string;
  accountDir: string;
  stateFile: string;
}

export interface VideoAccountSyncChanges {
  added: VideoAccount[];
  removed: VideoAccount[];
  renamed: Array<{
    previous: VideoAccount;
    next: VideoAccount;
  }>;
}

export type VideoAccountRuntimeStatus = {
  videoAccountId: string;
  videoAccountName: string;
  contractSubject?: string;
  launched: boolean;
  loginState: "not-launched" | "login-required" | "logged-in" | "unknown";
  pageCount: number;
  activeUrl?: string;
  userDataDir: string;
}

export class BrowserContextManager {
  private readonly channels = new Map<string, ManagedChannel>();
  private readonly videoAccountsById = new Map<string, VideoAccount>();
  private readonly loginRequiredNotifiedChannelIds = new Set<string>();

  constructor(
    private readonly config: ServiceConfig,
    private readonly notifier = new FeishuNotifier(),
  ) {
    this.syncVideoAccounts(config.videoAccounts);
  }

  async initialize(): Promise<void> {
    await mkdir(resolveFromRoot(this.config.authRoot), { recursive: true });
    browserLogger.info("账号浏览器配置已加载", { count: this.config.videoAccounts.length });
    for (const account of this.config.videoAccounts) {
      browserLogger.info("账号已加载", {
        accountId: account.id,
        accountName: account.name,
        contractSubject: account.contractSubject,
      });
    }
  }

  list(): Array<{ channelId: string; videoAccountId: string; videoAccountName: string; contractSubject?: string; userDataDir: string }> {
    return Array.from(this.videoAccountsById.values()).map((account) => {
      const channel = this.channels.get(account.id);
      return {
        channelId: account.id,
        videoAccountId: account.id,
        videoAccountName: account.name,
        contractSubject: account.contractSubject,
        userDataDir: channel?.userDataDir ?? this.getUserDataDir(account.id),
      };
    });
  }

  getRuntimeStatuses(): VideoAccountRuntimeStatus[] {
    return Array.from(this.videoAccountsById.values()).map((account) => {
      const channel = this.channels.get(account.id);
      const pages = channel?.context.pages() ?? [];
      const activePage = pages.find((page) => !page.isClosed() && page.url() !== "about:blank") ?? pages[0];
      const activeUrl = activePage?.url();
      const hasLoginPage = pages.some((page) => !page.isClosed() && page.url().includes("login"));
      const hasPlatformPage = pages.some((page) => {
        const url = page.url();
        return !page.isClosed() && url !== "about:blank" && !url.includes("login");
      });
      const loginState: VideoAccountRuntimeStatus["loginState"] = !channel
        ? "not-launched"
        : hasLoginPage || this.loginRequiredNotifiedChannelIds.has(account.id)
          ? "login-required"
          : hasPlatformPage
            ? "logged-in"
            : "unknown";

      return {
        videoAccountId: account.id,
        videoAccountName: account.name,
        contractSubject: account.contractSubject,
        launched: Boolean(channel),
        loginState,
        pageCount: pages.filter((page) => !page.isClosed()).length,
        activeUrl: activeUrl && activeUrl !== "about:blank" ? activeUrl : undefined,
        userDataDir: channel?.userDataDir ?? this.getUserDataDir(account.id),
      };
    });
  }

  get(channelId: string): BrowserContext {
    const channel = this.channels.get(channelId);
    if (!channel) {
      if (this.has(channelId)) {
        throw new Error(`Channel is not launched yet: ${channelId}`);
      }
      throw new Error(`Unknown channelId: ${channelId}`);
    }
    return channel.context;
  }

  has(channelId: string): boolean {
    return this.videoAccountsById.has(channelId);
  }

  async getOrLaunch(channelId: string): Promise<BrowserContext> {
    const channel = this.channels.get(channelId);
    if (channel) return channel.context;
    return runWithLogContext({
      videoAccountId: channelId,
      videoAccountName: this.getVideoAccountName(channelId),
    }, () => this.launch(channelId));
  }

  getDefaultChannelId(): string {
    const firstAccount = this.videoAccountsById.values().next().value as VideoAccount | undefined;
    if (!firstAccount) throw new Error("Video account list must contain at least one account.");
    return firstAccount.id;
  }

  getVideoAccountName(channelId: string): string {
    return this.videoAccountsById.get(channelId)?.name ?? channelId;
  }

  syncVideoAccounts(videoAccounts: VideoAccount[]): VideoAccountSyncChanges {
    const nextAccountsById = new Map(videoAccounts.map((account) => [account.id, account]));
    const added: VideoAccount[] = [];
    const removed: VideoAccount[] = [];
    const renamed: VideoAccountSyncChanges["renamed"] = [];

    for (const account of videoAccounts) {
      const previous = this.videoAccountsById.get(account.id);
      if (!previous) {
        added.push(account);
      } else if (previous.name !== account.name) {
        renamed.push({ previous, next: account });
      }
    }

    for (const previous of this.videoAccountsById.values()) {
      if (!nextAccountsById.has(previous.id)) {
        removed.push(previous);
        this.loginRequiredNotifiedChannelIds.delete(previous.id);
      }
    }

    this.videoAccountsById.clear();
    for (const account of videoAccounts) {
      this.videoAccountsById.set(account.id, account);
    }
    for (const { next } of renamed) {
      this.refreshPageTitles(next.id);
    }

    return { added, removed, renamed };
  }

  async updateCredentials(channelId: string, credentials: UpdateCredentialsRequest): Promise<void> {
    await this.getOrLaunch(channelId);
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channelId: ${channelId}`);
    if (!Array.isArray(credentials.cookies)) {
      throw new Error("credentials.cookies must be an array.");
    }

    await channel.context.clearCookies();
    if (credentials.cookies.length > 0) {
      await channel.context.addCookies(credentials.cookies);
    }

    for (const originState of credentials.origins ?? []) {
      const page = await channel.context.newPage();
      try {
        await page.goto(originState.origin, { waitUntil: "domcontentloaded" });
        await page.evaluate((items) => {
          localStorage.clear();
          for (const item of items) localStorage.setItem(item.name, item.value);
        }, originState.localStorage);
      } finally {
        await page.close();
      }
    }

    await this.writeStorageState(channel);
  }

  async save(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channelId: ${channelId}`);
    await this.writeStorageState(channel);
  }

  async saveAll(): Promise<void> {
    await Promise.all(Array.from(this.channels.values(), (channel) => this.writeStorageState(channel)));
  }

  async ensureLoggedIn(channelId: string): Promise<void> {
    const context = await this.getOrLaunch(channelId);
    const pages = context.pages();
    const page = pages.find((candidate) => !candidate.url().includes("/login") && candidate.url() !== "about:blank")
      ?? pages[0]
      ?? await context.newPage();
    await page.goto(playletUrl, { waitUntil: "domcontentloaded" });

    const accountLabel = `videoAccountId=${channelId} name=${this.getVideoAccountName(channelId)}`;
    const loggedIn = await waitForLoginIfNeeded(page, accountLabel, this.getPageTitle(channelId), () =>
      this.notifyLoginRequired(channelId));
    if (loggedIn) {
      this.loginRequiredNotifiedChannelIds.delete(channelId);
      browserLogger.info("登录状态已保存", {
        accountId: channelId,
        accountName: this.getVideoAccountName(channelId),
      });
      await this.save(channelId);
    } else {
      browserLogger.info("账号已登录", {
        accountId: channelId,
        accountName: this.getVideoAccountName(channelId),
      });
    }
  }

  async waitForLoginPageIfOpen(channelId: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    const loginPage = channel.context.pages().find((page) => page.url().includes("/login"));
    if (!loginPage) return false;

    const accountLabel = `videoAccountId=${channelId} name=${this.getVideoAccountName(channelId)}`;
    browserLogger.warn("领取任务前检测到登录页", {
      accountId: channelId,
      accountName: this.getVideoAccountName(channelId),
    });
    const loggedIn = await waitForLoginIfNeeded(loginPage, accountLabel, this.getPageTitle(channelId), () =>
      this.notifyLoginRequired(channelId));
    if (loggedIn) {
      this.loginRequiredNotifiedChannelIds.delete(channelId);
      await this.save(channelId);
    }
    return loggedIn;
  }

  async focusVideoAccount(channelId: string): Promise<void> {
    const context = await this.getOrLaunch(channelId);
    const page = context.pages().find((candidate) => !candidate.isClosed() && candidate.url() !== "about:blank")
      ?? context.pages()[0]
      ?? await context.newPage();

    await page.bringToFront();
    await page.evaluate(() => {
      window.focus();
    }).catch(() => undefined);
  }

  async waitForAuthenticatedSession(channelId: string, timeoutMs: number): Promise<boolean> {
    const context = await this.getOrLaunch(channelId);
    const deadline = Date.now() + Math.max(0, timeoutMs);

    browserLogger.info("等待账号完成登录", {
      accountId: channelId,
      accountName: this.getVideoAccountName(channelId),
      timeoutMs,
    });
    while (Date.now() < deadline) {
      if (this.channels.get(channelId)?.context !== context) return false;

      const remainingMs = deadline - Date.now();
      const pages = context.pages().filter((candidate) =>
        !candidate.isClosed() && candidate.url() !== "about:blank"
      );
      for (const page of pages) {
        const loggedIn = await this.hasAuthenticatedPlatformSession(
          page,
          Math.min(3000, remainingMs),
        );
        if (!loggedIn) continue;

        this.loginRequiredNotifiedChannelIds.delete(channelId);
        await this.save(channelId);
        browserLogger.info("登录成功", {
          accountId: channelId,
          accountName: this.getVideoAccountName(channelId),
        });
        return true;
      }

      await this.waitForAuthenticationActivity(context, Math.min(1000, remainingMs));
    }

    browserLogger.warn("等待登录超时", {
      accountId: channelId,
      accountName: this.getVideoAccountName(channelId),
    });
    return false;
  }

  async refreshLoginStateInTemporaryPage(channelId: string, timeoutMs: number): Promise<boolean> {
    const context = await this.getOrLaunch(channelId);
    const existingPages = context.pages().filter((candidate) => !candidate.isClosed());
    const reusableBlankPage = existingPages.find((candidate) => candidate.url() === "about:blank");
    const page = reusableBlankPage ?? await context.newPage();
    const shouldClosePage = !reusableBlankPage && existingPages.length > 0;

    try {
      browserLogger.info(
        shouldClosePage
          ? "已打开临时页面检查登录状态"
          : "已复用浏览器页面检查登录状态",
        {
          accountId: channelId,
          accountName: this.getVideoAccountName(channelId),
        },
      );
      await page.goto(playletUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

      const loggedIn = await this.hasAuthenticatedPlatformSession(page, timeoutMs);
      if (!loggedIn) {
        await this.setPageTitle(page, this.getPageTitle(channelId));
        this.notifyLoginRequired(channelId);
        browserLogger.warn("空闲页刷新时需要重新登录", {
          accountId: channelId,
          accountName: this.getVideoAccountName(channelId),
        });
        return false;
      }

      this.loginRequiredNotifiedChannelIds.delete(channelId);
      await this.save(channelId);
      browserLogger.info("空闲页刷新后已保存登录状态", {
        accountId: channelId,
        accountName: this.getVideoAccountName(channelId),
      });
      return true;
    } finally {
      if (shouldClosePage) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
      }
    }
  }

  private async hasAuthenticatedPlatformSession(page: Page, timeoutMs: number): Promise<boolean> {
    if (page.url().includes("login")) return false;
    if (await page.locator(loginQrCodeSelector).first().isVisible().catch(() => false)) return false;

    const probeTimeoutMs = Math.min(10000, Math.max(1000, timeoutMs));
    return page.evaluate(async ({ url, requestTimeoutMs }) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          referrer: "https://channels.weixin.qq.com/micro/content/playlet/",
          body: JSON.stringify({
            pageSize: 1,
            currentPage: 1,
            queryString: "",
            _log_finder_uin: "",
            rawKeyBuff: "",
            pluginSessionId: null,
            scene: 7,
            reqScene: 7,
          }),
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) return false;
        const payload = await response.json() as { errCode?: number };
        return payload.errCode === 0;
      } catch {
        return false;
      } finally {
        window.clearTimeout(timer);
      }
    }, {
      url: nativeDramaListUrl,
      requestTimeoutMs: probeTimeoutMs,
    }).catch(() => false);
  }

  private async waitForAuthenticationActivity(
    context: BrowserContext,
    timeoutMs: number,
  ): Promise<void> {
    if (timeoutMs <= 0) return;

    const activityWaiters: Promise<unknown>[] = [
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      context.waitForEvent("page", { timeout: timeoutMs }).catch(() => undefined),
      context.waitForEvent("close", { timeout: timeoutMs }).catch(() => undefined),
    ];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      activityWaiters.push(
        page.waitForEvent("framenavigated", {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: timeoutMs,
        }).catch(() => undefined),
      );
    }

    await Promise.race(activityWaiters);
  }

  async close(): Promise<void> {
    await this.saveAll().catch(() => undefined);
    await Promise.all(Array.from(this.channels.values(), ({ context }) => context.close()));
    this.channels.clear();
  }

  private async launch(channelId: string, initialUrl?: string): Promise<BrowserContext> {
    if (!this.has(channelId)) {
      throw new Error(`Unknown channelId: ${channelId}`);
    }

    const accountDir = this.getAccountDir(channelId);
    const userDataDir = this.getUserDataDir(channelId);
    const stateFile = path.join(accountDir, "storage-state.json");
    await mkdir(accountDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    browserLogger.info("正在启动账号浏览器", {
      accountId: channelId,
      accountName: this.getVideoAccountName(channelId),
      path: userDataDir,
    });

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.config.browser.headless,
      slowMo: this.config.browser.slowMo, // 让每一步操作人为变慢
      viewport: null,
      acceptDownloads: true, // 控制浏览器是否允许下载文件
      ignoreDefaultArgs: ["--enable-automation"],
    });

    const channel = { context, userDataDir, accountDir, stateFile };
    context.once("close", () => {
      if (this.channels.get(channelId)?.context === context) {
        this.channels.delete(channelId);
      }
    });
    await this.installFixedPageTitle(context, channelId);

    this.channels.set(channelId, channel);
    if (initialUrl) {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(initialUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await this.setPageTitle(page, this.getPageTitle(channelId));
    }
    return context;
  }

  private notifyLoginRequired(channelId: string): void {
    if (this.loginRequiredNotifiedChannelIds.has(channelId)) return;

    this.loginRequiredNotifiedChannelIds.add(channelId);
    void this.notifier.notifyLoginRequired(channelId, this.getVideoAccountName(channelId));
  }

  private getPageTitle(channelId: string): string {
    return this.getVideoAccountName(channelId);
  }

  private async installFixedPageTitle(context: BrowserContext, channelId: string): Promise<void> {
    const title = this.getPageTitle(channelId);
    await context.addInitScript((fixedTitle) => {
      const windowState = window as unknown as {
        __videoAccountFixedTitle?: string;
        __videoAccountFixedTitleInstalled?: boolean;
      };
      windowState.__videoAccountFixedTitle = fixedTitle;
      const applyTitle = () => {
        const title = windowState.__videoAccountFixedTitle ?? fixedTitle;
        if (document.title !== title) {
          document.title = title;
        }
      };
      const watchTitle = () => {
        applyTitle();
        const titleElement = document.querySelector("title") ?? document.head?.appendChild(document.createElement("title"));
        if (!titleElement || titleElement.dataset.fixedVideoAccountTitle === "true") return;

        titleElement.dataset.fixedVideoAccountTitle = "true";
        new MutationObserver(applyTitle).observe(titleElement, {
          characterData: true,
          childList: true,
          subtree: true,
        });
      };

      if (windowState.__videoAccountFixedTitleInstalled) {
        applyTitle();
        return;
      }

      windowState.__videoAccountFixedTitleInstalled = true;
      watchTitle();
      window.addEventListener("DOMContentLoaded", watchTitle);
      window.addEventListener("load", watchTitle);
      window.setInterval(applyTitle, 1000);
    }, title);

    context.on("page", (page) => {
      this.keepPageTitle(page, channelId);
    });
    for (const page of context.pages()) {
      this.keepPageTitle(page, channelId);
    }
  }

  private keepPageTitle(page: Page, channelId: string): void {
    const applyTitle = () => {
      void this.setPageTitle(page, this.getPageTitle(channelId));
    };
    page.on("domcontentloaded", applyTitle);
    page.on("load", applyTitle);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) applyTitle();
    });
    applyTitle();
  }

  private refreshPageTitles(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    for (const page of channel.context.pages()) {
      void this.setPageTitle(page, this.getPageTitle(channelId));
    }
  }

  private async setPageTitle(page: Page, title: string): Promise<void> {
    await page.evaluate((value) => {
      const windowState = window as unknown as { __videoAccountFixedTitle?: string };
      windowState.__videoAccountFixedTitle = value;
      document.title = value;
    }, title).catch(() => undefined);
  }

  private getAccountDir(channelId: string): string {
    return resolveFromRoot(path.join(this.config.authRoot, encodeURIComponent(channelId)));
  }

  private getUserDataDir(channelId: string): string {
    return path.join(this.getAccountDir(channelId), "chromium-profile");
  }

  private async writeStorageState(channel: ManagedChannel): Promise<void> {
    const state = await channel.context.storageState();
    await writeFile(channel.stateFile, JSON.stringify(state, null, 2), "utf8");
  }
}
