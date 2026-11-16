import type { BrowserContext, Page, Response } from "playwright";
import { z } from "zod";
import { PINDUODUO_CREATOR_MANAGEMENT_LIST_URL, PINDUODUO_MCN_ORIGIN } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { PinduoduoDramaRuntimeOptions } from "../shared/types.js";

const SIGNED_CREATORS_PATH = "/api/cafe/anchor/list_signed_anchors";
const USER_INFO_PATH = "/api/cafe/login/user_info";
const creatorSchema = z.object({
  anchor_uid: z.union([z.string().regex(/^\d+$/), z.number().int().positive().safe()]),
  anchor_name: z.string().trim().min(1),
  room_id: z.string().optional(),
  upload_video: z.boolean().optional(),
  permit_operate: z.boolean().optional(),
});
const creatorListSchema = z.object({
  success: z.literal(true),
  result: z.object({
    model: z.array(creatorSchema),
    page: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    page_size: z.number().int().positive(),
  }),
});

export type PinduoduoCreatorAccount = z.infer<typeof creatorSchema>;

export function assertPinduoduoLoginPhone(displayedPhone: string, expectedPhone: string): void {
  if (!/^\d{3}[\d*]{4}\d{4}$/.test(displayedPhone) || !/^1\d{10}$/.test(expectedPhone) ||
    [...displayedPhone].some((digit, index) => digit !== "*" && digit !== expectedPhone[index])) {
    throw new Error("当前拼多多登录账号与飞书配置手机号不一致，请切换到正确账号后重新启动");
  }
}

export function selectPinduoduoCreator(
  creators: PinduoduoCreatorAccount[],
  expectedName?: string,
): PinduoduoCreatorAccount {
  const name = expectedName?.trim();
  const matches = name ? creators.filter((creator) => creator.anchor_name === name) : creators;
  if (matches.length === 0) {
    throw new Error(name ? `未在当前登录账号下找到主播“${name}”，请检查登录账号和主播名称` : "当前登录账号下没有可用的主播");
  }
  if (matches.length !== 1) {
    throw new Error(name ? `当前账号下存在多个同名主播“${name}”，无法安全确定发布对象` : "当前账号下有多个主播，请在配置中填写主播名称");
  }
  const creator = matches[0]!;
  if (creator.upload_video !== true || creator.permit_operate !== true) {
    throw new Error(`主播“${creator.anchor_name}”没有可用的视频上传权限`);
  }
  return creator;
}

function isCreatorListResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.origin === PINDUODUO_MCN_ORIGIN && url.pathname === SIGNED_CREATORS_PATH;
}

/** Read the site's own signed requests; a plain fetch of this endpoint can fail. */
export async function resolvePinduoduoCreator(
  context: BrowserContext,
  options: PinduoduoDramaRuntimeOptions,
): Promise<PinduoduoCreatorAccount> {
  const page = await context.newPage();
  try {
    options.signal?.throwIfAborted();
    const creators = new Map<string, PinduoduoCreatorAccount>();
    let responsePromise = page.waitForResponse(isCreatorListResponse, { timeout: 30_000 });
    // Attach the rejection handler before navigation to avoid unhandled wait failures.
    void responsePromise.catch(() => undefined);
    const loginResponse = options.accountPhone ? page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === PINDUODUO_MCN_ORIGIN && url.pathname === USER_INFO_PATH;
    }, { timeout: 30_000 }) : undefined;
    void loginResponse?.catch(() => undefined);
    await page.goto(PINDUODUO_CREATOR_MANAGEMENT_LIST_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (loginResponse) {
      const payload = z.object({ success: z.literal(true), result: z.object({ user_name: z.string() }) }).parse(await (await loginResponse).json());
      assertPinduoduoLoginPhone(payload.result.user_name, options.accountPhone!);
    }
    let previousPage = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const response = await responsePromise;
      if (!response.ok()) throw new Error(`获取拼多多主播列表失败：HTTP ${response.status()}`);
      const { result } = creatorListSchema.parse(await response.json());
      if (result.page !== previousPage + 1) throw new Error("拼多多主播列表分页异常，已停止选择主播");
      previousPage = result.page;
      for (const creator of result.model) creators.set(String(creator.anchor_uid), creator);
      if (result.page * result.page_size >= result.total) break;
      if (result.model.length === 0) throw new Error("拼多多主播列表分页为空，无法确认发布对象");
      await clickNextCreatorPage(page, () => {
        responsePromise = page.waitForResponse(isCreatorListResponse, { timeout: 30_000 });
        void responsePromise.catch(() => undefined);
      });
    }
    const creator = selectPinduoduoCreator([...creators.values()], options.config?.creatorName);
    log(options, "info", "runtime", "resolved Pinduoduo creator from signed author list", {
      accountProfileName: options.accountProfileName,
      creatorName: creator.anchor_name,
      creatorUid: String(creator.anchor_uid),
      creatorId: creator.room_id,
    });
    return creator;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function clickNextCreatorPage(page: Page, beforeClick: () => void): Promise<void> {
  const next = page.locator('[title="下一页"], [aria-label="下一页"], [data-testid="beast-core-pagination-next"]').first();
  await next.waitFor({ state: "visible", timeout: 10_000 });
  beforeClick();
  await next.click({ timeout: 10_000 });
}
