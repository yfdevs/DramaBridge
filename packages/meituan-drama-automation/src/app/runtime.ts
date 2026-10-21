import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import {
  MEITUAN_CREATION_LOGIN_URL,
  MEITUAN_CREATION_PUBLISH_VIDEO_URL,
} from "../shared/constants.js";
import type {
  MeituanCreationAccount,
  MeituanCreationRuntime,
  MeituanCreationRuntimeOptions,
  MeituanCreationRuntimeStatus,
} from "../shared/types.js";
import {
  cleanupOldLogFiles,
  loginStateFromUrl,
  log,
  saveCredentialState,
} from "../automation/browser-session.js";
import { runPublishTask } from "../automation/publish-runner.js";
import { runMeituanAccountTaskWorker } from "./task-worker.js";

type AccountBrowser = {
  account: MeituanCreationAccount;
  context: BrowserContext;
  page: Page;
  options: MeituanCreationRuntimeOptions;
  userDataDir: string;
  launched: boolean;
  workerPromise?: Promise<void>;
};

function accountPathSegment(accountId: string) {
  return encodeURIComponent(accountId);
}

function accountRuntimeOptions(
  options: MeituanCreationRuntimeOptions,
  account: MeituanCreationAccount,
): MeituanCreationRuntimeOptions {
  const accountDir = path.join(
    options.authRoot!,
    "accounts",
    accountPathSegment(account.accountId),
  );
  return {
    ...options,
    userDataDir: path.join(accountDir, "chromium-profile"),
    credentialStatePath: path.join(accountDir, "storage-state.json"),
    assetDownloadDir: options.assetDownloadRoot
      ? path.join(options.assetDownloadRoot, accountPathSegment(account.accountId), "covers")
      : undefined,
    meituanAccountId: account.accountId,
    meituanAccountName: account.accountName,
    onLog: options.onLog,
  };
}

async function setPageTitle(page: Page, title: string) {
  await page.evaluate((value) => {
    const windowState = window as unknown as { __meituanAccountFixedTitle?: string };
    windowState.__meituanAccountFixedTitle = value;
    document.title = value;
  }, title).catch(() => undefined);
}

async function installFixedPageTitle(
  context: BrowserContext,
  accountName: string,
) {
  await context.addInitScript((fixedTitle) => {
    const windowState = window as unknown as {
      __meituanAccountFixedTitle?: string;
      __meituanAccountFixedTitleInstalled?: boolean;
    };
    windowState.__meituanAccountFixedTitle = fixedTitle;

    const applyTitle = () => {
      const title = windowState.__meituanAccountFixedTitle ?? fixedTitle;
      if (document.title !== title) document.title = title;
    };
    const watchTitle = () => {
      applyTitle();
      const titleElement =
        document.querySelector("title") ??
        document.head?.appendChild(document.createElement("title"));
      if (!titleElement || titleElement.dataset.fixedMeituanAccountTitle === "true") return;

      titleElement.dataset.fixedMeituanAccountTitle = "true";
      new MutationObserver(applyTitle).observe(titleElement, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    };

    if (windowState.__meituanAccountFixedTitleInstalled) {
      applyTitle();
      return;
    }
    windowState.__meituanAccountFixedTitleInstalled = true;
    watchTitle();
    window.addEventListener("DOMContentLoaded", watchTitle);
    window.addEventListener("load", watchTitle);
    window.setInterval(applyTitle, 1000);
  }, accountName);

  const keepPageTitle = (page: Page) => {
    const applyTitle = () => {
      void setPageTitle(page, accountName);
    };
    page.on("domcontentloaded", applyTitle);
    page.on("load", applyTitle);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) applyTitle();
    });
    applyTitle();
  };

  context.on("page", keepPageTitle);
  for (const page of context.pages()) keepPageTitle(page);
}

export async function startMeituanCreationRuntime(
  options: MeituanCreationRuntimeOptions = {},
): Promise<MeituanCreationRuntime> {
  if (!options.authRoot) {
    throw new Error("Meituan creation authRoot is required.");
  }
  if (!options.accounts?.length) {
    throw new Error("MEITUAN_ENABLED_ACCOUNT_NOT_FOUND");
  }

  let running = true;
  const accountBrowsers: AccountBrowser[] = [];

  await cleanupOldLogFiles(options).catch(() => undefined);

  try {
    for (const account of options.accounts) {
      const browserOptions = accountRuntimeOptions(options, account);
      const userDataDir = browserOptions.userDataDir!;
      const existingProfile = await stat(path.join(userDataDir, "Default"))
        .then((entry) => entry.isDirectory())
        .catch(() => false);
      await mkdir(userDataDir, { recursive: true });
      log(
        browserOptions,
        `[meituan-drama] starting account browser: userDataDir=${userDataDir} existingProfile=${existingProfile}`,
      );
      const context = await launchPlatformBrowserContext(userDataDir, {
        viewport: null,
        headless: options.config?.browser?.headless ?? false,
        slowMo: options.config?.browser?.slowMo ?? 20,
      });
      await installFixedPageTitle(context, account.accountName);
      const page = context.pages()[0] ?? (await context.newPage());
      const browser: AccountBrowser = {
        account,
        context,
        page,
        options: browserOptions,
        userDataDir,
        launched: true,
      };
      accountBrowsers.push(browser);
      context.on("close", () => {
        browser.launched = false;
        if (accountBrowsers.every((accountBrowser) => !accountBrowser.launched)) {
          running = false;
        }
      });

      const workerPromise = (
        options.taskPollingEnabled === false
          ? runPublishTask(context, page, browserOptions, null).then(() => undefined)
          : runMeituanAccountTaskWorker({
            account,
            context,
            page,
            runtimeOptions: browserOptions,
            isRunning: () => running && browser.launched,
          })
      ).catch((error) => {
        log(
          browserOptions,
          `[meituan-drama] account worker stopped with error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      browser.workerPromise = workerPromise;
    }
  } catch (error) {
    running = false;
    await Promise.allSettled(accountBrowsers.map((browser) => browser.context.close()));
    throw error;
  }

  log(options, `[meituan-drama] started ${accountBrowsers.length} account browser(s)`);

  return {
    getStatus(): MeituanCreationRuntimeStatus {
      return {
        platform: "meituan-drama",
        loginUrl: MEITUAN_CREATION_LOGIN_URL,
        publishVideoUrl: MEITUAN_CREATION_PUBLISH_VIDEO_URL,
        running,
        accounts: accountBrowsers.map((browser) => {
          const openPages = browser.context.pages().filter((page) => !page.isClosed());
          const activePage = openPages.find((page) => page.url().includes("/new/login"))
            ?? openPages[openPages.length - 1]
            ?? browser.page;
          const activeUrl = activePage.url();
          return {
            accountId: browser.account.accountId,
            accountName: browser.account.accountName,
            loginAccount: browser.account.loginAccount,
            launched: browser.launched,
            loginState: activeUrl ? loginStateFromUrl(activeUrl) : "unknown",
            activeUrl,
            userDataDir: browser.userDataDir,
          };
        }),
      };
    },
    async stop() {
      running = false;
      await Promise.allSettled(
        accountBrowsers.map(async (browser) => {
          await saveCredentialState(browser.context, browser.options).catch(() => undefined);
          await browser.context.close();
          browser.launched = false;
        }),
      );
      await Promise.allSettled(
        accountBrowsers.flatMap((browser) => (
          browser.workerPromise ? [browser.workerPromise] : []
        )),
      );
      log(options, "[meituan-drama] all account browsers stopped");
    },
  };
}
