import type { Page } from "playwright";

export async function waitForWeiboAction<T>(
  page: Page,
  action: () => Promise<unknown>,
  completion: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let outcome: { value: T } | { error: unknown } | undefined;
  void completion.then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  );
  options.signal?.throwIfAborted();
  await action();
  while (!outcome) {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error("WEIBO_DRAMA_ACTION_TIMEOUT: 微博操作超过等待时限，已停止等待，请核对后台结果后重试");
    const messages = await page
      .locator(".el-message--error:visible,.el-form-item.is-error .el-form-item__label:visible")
      .allInnerTexts();
    const errors = [
      ...new Set(messages.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)),
    ];
    if (errors.length) throw new Error(`WEIBO_DRAMA_FORM_VALIDATION_FAILED: ${errors.join("；")}`);
    await page.waitForTimeout(250);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
