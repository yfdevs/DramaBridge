import type { BrowserContext, Page } from "playwright";

export class KuaishouBrowserUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("快手自动化浏览器连接已断开，当前任务已中断。请重新启动快手服务后重试");
    this.cause = cause;
  }
}

function isClosedTargetError(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (/Target (?:page, context or browser|page|context|browser) has been closed|Target closed|page (?:has )?crashed/i.test(message)) return true;
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** Recover read-only queries and pages before upload; never replay a submission. */
export class KuaishouTaskPages {
  private queryPage: Page;
  private disconnected = false;
  private readonly crashed = new Set<Page>();
  private readonly watched = new Map<Page, () => void>();
  private readonly replacements = new Set<Page>();
  private readonly onClose = () => { this.disconnected = true; };

  constructor(
    private readonly context: BrowserContext,
    initialPage: Page,
    private readonly initialize: (page: Page) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {
    this.queryPage = initialPage;
    context.on("close", this.onClose);
    this.watch(initialPage);
  }

  private watch(page: Page) {
    const onCrash = () => { this.crashed.add(page); this.log("任务页发生崩溃"); };
    page.on("crash", onCrash);
    this.watched.set(page, onCrash);
  }

  failure(error?: unknown): unknown {
    if (this.disconnected || this.context.browser()?.isConnected() === false) {
      return error instanceof KuaishouBrowserUnavailableError ? error : new KuaishouBrowserUnavailableError(error);
    }
    return error;
  }

  assertConnected() {
    const failure = this.failure();
    if (failure) throw failure;
  }

  private async replaceQueryPage() {
    this.assertConnected();
    this.log("任务页已失效，正在新建页面恢复查询");
    try {
      const next = await this.context.newPage();
      this.replacements.add(next);
      this.watch(next);
      this.queryPage = next;
      await this.initialize(next);
    } catch (error) {
      throw this.failure(error);
    }
  }

  async readyQueryPage() {
    this.assertConnected();
    if (this.queryPage.isClosed() || this.crashed.has(this.queryPage)) await this.replaceQueryPage();
    return this.queryPage;
  }

  async read<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const page = await this.readyQueryPage();
      try {
        return await operation(page);
      } catch (error) {
        const failure = this.failure(error);
        if (failure instanceof KuaishouBrowserUnavailableError) throw failure;
        if (attempt > 0 || (!page.isClosed() && !this.crashed.has(page) && !isClosedTargetError(error))) throw error;
        await this.replaceQueryPage();
      }
    }
  }

  async newUploadPage() {
    this.assertConnected();
    try {
      const page = await this.context.newPage();
      this.watch(page);
      return page;
    } catch (error) {
      throw this.failure(error);
    }
  }

  async dispose() {
    this.context.off("close", this.onClose);
    for (const [page, onCrash] of this.watched) page.off("crash", onCrash);
    // The runtime owns the initial page; only close replacement query pages here.
    await Promise.all([...this.replacements].map(page => page.close().catch(() => undefined)));
  }
}
