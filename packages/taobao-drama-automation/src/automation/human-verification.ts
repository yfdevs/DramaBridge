import type { Frame, Page } from "playwright";
import { log } from "../shared/logger.js";
import type { TaobaoDramaRuntimeOptions } from "../shared/types.js";

const activeVerificationPrompt =
  /请拖动下方滑块完成验证|请按住滑块，拖动到最右边|通过验证以确保正常访问|请依次点击|请完成安全验证|请完成验证/;
const passedVerificationPrompt = /验证通过|校验通过|验证成功|验证已完成/;

export function isTaobaoVerificationChallenge(input: {
  visibleControlCount: number;
  activeControlCount?: number;
  successControlCount?: number;
  text: string;
}) {
  const normalized = input.text.replace(/\s+/g, " ");
  const textWithoutInstruction = normalized.replace(/验证通过后(?:继续|即可继续)?/g, "");
  if (passedVerificationPrompt.test(textWithoutInstruction) || (input.successControlCount ?? 0) > 0) {
    return false;
  }
  if (activeVerificationPrompt.test(normalized)) return true;

  // The outer #nocaptcha container commonly stays visible after a successful
  // manual verification. Only an actionable slider/captcha control is evidence
  // that the challenge is still pending.
  if (input.activeControlCount !== undefined) return input.activeControlCount > 0;
  return input.visibleControlCount > 0;
}

async function verificationEvidence(frame: Frame) {
  const visibleControlCount = await frame.locator([
    "#nocaptcha:visible",
    "#nc_1_n1z:visible",
    "#nc-verify-form:visible",
    ".captcha-tips:visible",
    ".bannar:visible .slidetounlock:visible",
  ].join(", ")).count().catch(() => 0);
  const activeControlCount = await frame.locator([
    "#nc_1_n1z.btn_slide:visible",
    "#nc_1_n1z:not(.btn_ok):not(.btn_success):visible",
    "#nc-verify-form:visible canvas:visible",
    "#nc-verify-form:visible input:visible",
    ".bannar:visible .slidetounlock:visible",
  ].join(", ")).count().catch(() => 0);
  const successControlCount = await frame.locator([
    "#nc_1_n1z.btn_ok:visible",
    "#nc_1_n1z.btn_success:visible",
    "#nc-verify-form:visible [class*='success']:visible",
  ].join(", ")).count().catch(() => 0);
  const text = await frame.locator("body").innerText({ timeout: 500 }).catch(() => "");
  return { visibleControlCount, activeControlCount, successControlCount, text };
}

export async function taobaoVerificationTargets(page: Page) {
  const targets: string[] = [];
  const relatedPages = [page];
  for (const candidate of page.context().pages()) {
    if (candidate === page || candidate.isClosed()) continue;
    if (await candidate.opener().catch(() => null) === page) relatedPages.push(candidate);
  }

  // Inspect the current task page, its child frames and popups opened by it.
  // Old failed task tabs may retain a visible no-captcha container forever and
  // must not pause a new task.
  for (const relatedPage of relatedPages) {
    for (const frame of relatedPage.frames()) {
      const evidence = await verificationEvidence(frame);
      if (isTaobaoVerificationChallenge(evidence)) {
        targets.push(frame.url() || relatedPage.url());
      }
    }
  }
  return [...new Set(targets)];
}

export async function waitForTaobaoHumanVerification(
  page: Page,
  options: TaobaoDramaRuntimeOptions,
) {
  const startedAt = Date.now();
  let waiting = false;
  let clearPolls = 0;
  let lastHeartbeatAt = startedAt;
  while (!page.isClosed()) {
    const targets = await taobaoVerificationTargets(page);
    if (targets.length === 0) {
      if (!waiting) return 0;
      clearPolls += 1;
      if (clearPolls >= 2) {
        const waitedMs = Date.now() - startedAt;
        log(options, `[taobao-drama] 淘宝滑块验证已完成，等待页面恢复后继续当前步骤 ` +
          `{ waitedSeconds=${Math.ceil(waitedMs / 1_000)} }`);
        await page.bringToFront().catch(() => undefined);
        await page.waitForTimeout(2_000);
        return waitedMs;
      }
    } else {
      clearPolls = 0;
      if (!waiting) {
        waiting = true;
        log(
          options,
          `[taobao-drama] 检测到淘宝滑块验证，任务已暂停，请运营人员手动完成验证；不会超时 ` +
            `{ pages=${targets.join(" | ")} }`,
        );
        await page.bringToFront().catch(() => undefined);
        await options.onHumanVerificationRequired?.({ pages: targets });
        // The native warning dialog temporarily takes focus. Bring the browser
        // back after the user acknowledges it so the slider can be handled
        // immediately without searching for the correct window.
        await page.bringToFront().catch(() => undefined);
      } else if (Date.now() - lastHeartbeatAt >= 30_000) {
        lastHeartbeatAt = Date.now();
        log(options, `[taobao-drama] 仍在等待人工完成淘宝验证，完成后将自动恢复当前步骤 ` +
          `{ waitedSeconds=${Math.ceil((Date.now() - startedAt) / 1_000)} }`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("TAOBAO_DRAMA_BROWSER_PAGE_CLOSED_DURING_VERIFICATION");
}

export async function runWithTaobaoVerificationRetry<T>(
  page: Page,
  options: TaobaoDramaRuntimeOptions,
  action: () => Promise<T>,
  actionLabel = "当前表单步骤",
  retryAfterSuccessfulVerification = true,
) {
  while (true) {
    await waitForTaobaoHumanVerification(page, options);
    let monitoring = true;
    let verificationSeen = false;
    let stopMonitoring!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stopMonitoring = resolve;
    });
    const monitor = (async () => {
      while (monitoring && !page.isClosed()) {
        if ((await taobaoVerificationTargets(page)).length > 0) verificationSeen = true;
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, 250)),
          stopSignal,
        ]);
      }
    })();
    try {
      const result = await action();
      const challengeActive = (await taobaoVerificationTargets(page)).length > 0;
      if (!verificationSeen && !challengeActive) return result;
      await waitForTaobaoHumanVerification(page, options);
      if (!retryAfterSuccessfulVerification) return result;
      log(options, `[taobao-drama] 验证在操作过程中出现，重新执行以确保内容生效：${actionLabel}`);
    } catch (error) {
      const challengeActive = (await taobaoVerificationTargets(page)).length > 0;
      if (!verificationSeen && !challengeActive) throw error;
      await waitForTaobaoHumanVerification(page, options);
      log(options, `[taobao-drama] 验证完成，重新定位控件并重试：${actionLabel}`);
    } finally {
      monitoring = false;
      stopMonitoring();
      await monitor;
    }
  }
}
