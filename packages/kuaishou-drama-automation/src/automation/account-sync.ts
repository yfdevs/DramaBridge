import { chromium, type Page } from "playwright";

export function accountSyncUrl(title: string) {
  const url = new URL("https://kdj.kuaishou.com/home/content/content-management");
  for (const [key, value] of Object.entries({ miniSeriesTitle: title.trim(), sellingStatus: "0", pageNum: "1", pageSize: "10", auditStatus: "3" })) url.searchParams.set(key, value);
  return url.href;
}
export function parseSyncAccounts(value: string) {
  const accounts = [...new Set(value.split(/[,，;；\n]+/).map(item => item.trim()).filter(Boolean))];
  if (!accounts.length || accounts.length > 100) throw new Error("同步账号需填写 1 至 100 个账号名称或 UID，以逗号分隔");
  return accounts;
}

export function parseSyncAccountTag(text: string) {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.*?)\s*\(UID\s*:\s*(\d+)\s*\)$/i);
  return match ? { name: match[1]!.trim(), uid: match[2]! } : undefined;
}

export function resolveSyncAccountTargets(targets: string[], history: string[]) {
  const accounts = history.map(parseSyncAccountTag).filter(account => account !== undefined);
  return [...new Set(targets.map(target => {
    const normalized = target.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (/^\d+$/.test(normalized)) return normalized;
    const explicit = parseSyncAccountTag(normalized);
    if (explicit) return explicit.uid;
    const matches = [...new Set(accounts.filter(account => account.name === normalized).map(account => account.uid))];
    if (matches.length !== 1) throw new Error(`完整历史使用中${matches.length ? "存在重名账号" : "未找到账号"}“${target}”，请检查名称或填写 UID`);
    return matches[0]!;
  }))];
}

export function syncHistoryLabels(response: unknown): string[] {
  const body = response as { result?: unknown; successful?: unknown; data?: unknown } | undefined;
  if (body?.result !== 1 || body.successful !== true || !Array.isArray(body.data)) throw new Error("读取完整历史同步账号失败，请重试");
  return body.data.map((item: { accountName?: unknown; uid?: unknown }) => {
    if (!item || typeof item.accountName !== "string" || !/^\d+$/.test(String(item.uid))) throw new Error("历史同步账号数据格式异常");
    return `${item.accountName}(UID: ${item.uid})`;
  });
}

export async function openKuaishouAccountSync(credentialStatePath: string) {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ storageState: credentialStatePath, viewport: { width: 1280, height: 900 } });
    const idle = await context.newPage();
    await idle.goto("https://kdj.kuaishou.com/home/content/content-management", { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (/passport|\/login/.test(idle.url())) throw new Error("登录状态已失效，请在实例页面重新登录");
    return { browser, context };
  } catch (error) { await browser.close(); throw error; }
}

export async function syncKuaishouAccounts(page: Page, title: string, targets: string[], beforeSubmit: () => void, onAccepted?: () => void) {
  await page.goto(accountSyncUrl(title), { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (/passport|\/login/.test(page.url())) throw new Error("登录状态已失效，请在实例页面登录后重新启动同步");
  const iframe = await page.waitForSelector("iframe#iframe-wrapper", { timeout: 30_000 });
  const content = await iframe.contentFrame();
  if (!content) throw new Error("快手内容页面尚未加载");
  const titleCell = content.getByText(title.trim(), { exact: true });
  const rows = content.locator(".ant-table-tbody > tr").filter({ has: titleCell });
  await rows.first().waitFor({ state: "visible", timeout: 30_000 });
  if (await rows.count() !== 1) throw new Error(`剧名“${title}”未唯一匹配，请检查快手内容列表`);
  await rows.getByRole("checkbox").check();
  await content.getByRole("button", { name: "批量同步至其他账号", exact: true }).click();
  const modal = content.locator(".ant-modal-content:visible").filter({ hasText: "批量同步至其他账号" });
  await modal.waitFor();
  const input = modal.locator('input[placeholder*="账号UID"], input[class*="input___"]');
  await modal.locator(".ant-spin-spinning").waitFor({ state: "hidden", timeout: 30_000 });
  const selectedTags = modal.locator('[class*="content___"] .ant-tag');
  // This read-only endpoint is the dialog's own full history source, including +N.
  // Resolve names without ever selecting unrelated accounts.
  const needsHistory = targets.some(target => !/^\d+$/.test(target.normalize("NFKC").trim()) && !parseSyncAccountTag(target));
  const history = needsHistory ? syncHistoryLabels(await content.evaluate(async () => {
    const response = await fetch('/rest/ad/miniSeries/product/pc/historySyncAccount', { credentials: 'include', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('读取历史同步账号失败');
    return response.json();
  })) : [];
  const targetUids = resolveSyncAccountTargets(targets, history);
  if (await selectedTags.count()) throw new Error("同步弹窗存在预选账号，已停止提交，请关闭任务页后重试");
  await input.fill(targetUids.join(","));
  await input.press("Enter");
  await content.waitForFunction((expected) => {
    return document.querySelectorAll('.ant-modal-content [class*="content___"] .ant-tag').length === expected;
  }, targetUids.length, { timeout: 15_000 });
  const selectedAccounts = await modal.locator('[class*="content___"] .ant-tag').allTextContents();
  for (const uid of targetUids) {
    if (!selectedAccounts.some(text => parseSyncAccountTag(text)?.uid === uid)) throw new Error(`账号 UID ${uid} 未成功添加，已停止提交`);
  }
  await modal.locator(".ant-select-selector").click();
  await content.getByText("保留原变现方式", { exact: true }).last().click();
  const confirm = modal.getByRole("button", { name: "确认同步", exact: true });
  await confirm.waitFor({ state: "visible" });
  // Capture transient notifications throughout submission, including ones that disappear.
  await content.waitForFunction(() => {
    const modal = document.querySelector('.ant-modal-content');
    const button = modal?.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary');
    return button && !button.disabled;
  }, undefined, { timeout: 30_000 });
  await content.evaluate(() => {
    const state = window as unknown as { syncWarnings: string[]; syncAlreadyDone: boolean; syncObserver?: MutationObserver };
    state.syncObserver?.disconnect(); state.syncWarnings = []; state.syncAlreadyDone = false;
    document.querySelectorAll('.ant-message-info, .ant-message-error, .ant-message-warning, .ant-notification-notice-error, .ant-notification-notice-warning, .ks-message--error, .ks-message--warning, .ant-form-item-explain-error').forEach(node => {
      const text = node.textContent?.trim();
      if (node.matches('.ant-message-info')) { if (text?.replace(/\s+/g, '') === '所有任务已同步过') state.syncAlreadyDone = true; return; }
      if (node.matches('.ant-message-warning') && text?.replace(/\s+/g, '') === '批量同步开始，请耐心等待同步完成') { state.syncAlreadyDone = true; return; }
      if (text && !state.syncWarnings.includes(text)) state.syncWarnings.push(text);
    });
    state.syncObserver = new MutationObserver(() => {
      document.querySelectorAll('.ant-message-info, .ant-message-error, .ant-message-warning, .ant-notification-notice-error, .ant-notification-notice-warning, .ks-message--error, .ks-message--warning, .ant-form-item-explain-error').forEach(node => {
        const text = node.textContent?.trim();
        if (node.matches('.ant-message-info')) { if (text?.replace(/\s+/g, '') === '所有任务已同步过') state.syncAlreadyDone = true; return; }
        if (node.matches('.ant-message-warning') && text?.replace(/\s+/g, '') === '批量同步开始，请耐心等待同步完成') { state.syncAlreadyDone = true; return; }
        if (text && !state.syncWarnings.includes(text)) state.syncWarnings.push(text);
      });
    });
    state.syncObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  beforeSubmit();
  let submittedAt = Date.now();
  let submissionError: unknown;
  try {
    await confirm.click({ timeout: 15_000 });
    submittedAt = Date.now();
    await content.waitForFunction(() => {
      const state = window as unknown as { syncWarnings: string[]; syncAlreadyDone: boolean };
      return state.syncAlreadyDone || state.syncWarnings.length > 0 || !Array.from(document.querySelectorAll('.ant-modal-content')).some(node => node.getClientRects().length && node.textContent?.includes('批量同步至其他账号'));
    }, undefined, { timeout: 30_000 });
    onAccepted?.();
  } catch (error) {
    submissionError = error;
  } finally {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 10_000 - (Date.now() - submittedAt))));
  }
  const warnings = await content.evaluate(() => {
    const state = window as unknown as { syncWarnings: string[]; syncObserver?: MutationObserver };
    state.syncObserver?.disconnect(); return state.syncWarnings;
  });
  if (warnings.length) throw new Error(warnings.join("；"));
  if (submissionError) throw submissionError;
  if (/passport|\/login/.test(page.url())) throw new Error("同步提交期间登录失效，请人工核实结果");
}
