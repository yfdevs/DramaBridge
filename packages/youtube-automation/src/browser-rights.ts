import type { Locator, Page } from "playwright";

// Deliberately use complete semantic labels: missing/ambiguous controls stop the task.
// Browser automation cannot grant options that YouTube does not expose to the channel.
export const youtubeRightsFields = [
  {
    kind: "choice",
    label: /^(上传政策|上传策略|Upload policy)$/i,
    value: /^(全球获利|Monetize in all countries|Monetize worldwide)$/i,
    description: "上传政策：全球获利",
  },
  {
    kind: "checkbox",
    label: /^(启用 Content ID|开启 Content ID 匹配|Content ID 匹配|Enable Content ID matching)$/i,
    description: "Content ID 匹配",
  },
  {
    kind: "choice",
    label: /^(匹配政策|匹配策略|Match policy)$/i,
    value: /^(全球屏蔽|Block in all countries|Block worldwide)$/i,
    description: "匹配政策：全球屏蔽",
  },
  {
    kind: "checkbox",
    label: /^(全球所有权|Worldwide ownership|我在全球拥有版权)$/i,
    description: "全球所有权",
  },
  {
    kind: "choice",
    label: /^(资产类型|Asset type)$/i,
    value: /^(网络|Web)$/i,
    description: "资产类型：网络",
  },
] as const;

async function oneVisible(locator: Locator, description: string) {
  const visible = locator.filter({ visible: true });
  if ((await visible.count()) !== 1)
    throw new Error(
      `当前视频编辑页未显示唯一的“${description}”选项，请检查频道权限或页面是否已变更`,
    );
  if (!(await visible.isEnabled()))
    throw new Error(`“${description}”选项不可用，请先在 YouTube Studio 检查原因`);
  return visible;
}

async function fields(page: Page) {
  const result: { field: (typeof youtubeRightsFields)[number]; locator: Locator }[] = [];
  for (const field of youtubeRightsFields) {
    const locator =
      field.kind === "checkbox"
        ? page.getByRole("checkbox", { name: field.label })
        : page
            .getByRole("combobox", { name: field.label })
            .or(page.getByRole("button", { name: field.label }));
    result.push({ field, locator: await oneVisible(locator, field.description) });
  }
  return result;
}

async function choiceMatches(control: Locator, value: RegExp) {
  return control.evaluate(
    (node, pattern) => {
      const text =
        node instanceof HTMLSelectElement
          ? (node.selectedOptions[0]?.textContent ?? "")
          : (node.textContent ?? "");
      return new RegExp(pattern.source, pattern.flags).test(text.trim());
    },
    { source: value.source, flags: value.flags },
  );
}

async function verified(page: Page) {
  for (const { field, locator } of await fields(page)) {
    if (
      field.kind === "checkbox"
        ? !(await locator.isChecked())
        : !(await choiceMatches(locator, field.value))
    )
      throw new Error(`YouTube 尚未确认保存“${field.description}”，已保留页面，请检查后重试`);
  }
}

export async function applyYoutubeBrowserRights(page: Page, assertActive: () => Promise<void>) {
  const target = new URL(page.url());
  if (
    target.origin !== "https://studio.youtube.com" ||
    !/^\/video\/[A-Za-z0-9_-]{11}\/edit$/.test(target.pathname)
  )
    throw new Error("未进入指定视频的 YouTube Studio 编辑页，停止版权操作");
  const save = page.getByRole("button", { name: /^(保存|Save)$/i });
  await save.waitFor({ state: "visible", timeout: 60_000 });
  const more = page.getByRole("button", {
    name: /^(显示高级设置|显示更多|展开更多|Show advanced settings|Show more)$/i,
  });
  if (await more.isVisible()) await more.click();
  // Resolve the complete plan before making a single business-setting change.
  const plan = await fields(page);
  for (const { field, locator } of plan) {
    await assertActive();
    if (field.kind === "checkbox") {
      await locator.setChecked(true);
    } else if (!(await choiceMatches(locator, field.value))) {
      if (await locator.evaluate((node) => node.tagName === "SELECT")) {
        const options = await locator
          .locator("option")
          .evaluateAll(
            (nodes, pattern) =>
              nodes
                .filter((node) =>
                  new RegExp(pattern.source, pattern.flags).test((node.textContent ?? "").trim()),
                )
                .map((node) => (node as HTMLOptionElement).value),
            { source: field.value.source, flags: field.value.flags },
          );
        if (options.length !== 1) throw new Error(`找不到唯一的“${field.description}”选项`);
        await locator.selectOption(options[0]);
      } else {
        await locator.click();
        await (
          await oneVisible(
            page
              .getByRole("option", { name: field.value })
              .or(page.getByRole("menuitem", { name: field.value })),
            field.description,
          )
        ).click();
      }
    }
  }
  await assertActive();
  await verified(page);
  if (await save.isEnabled()) {
    await save.click();
    const submitted = Date.now();
    // The safety buffer is additional to the save check, never a success signal.
    while (Date.now() - submitted < 10_000) {
      await assertActive();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500, 10_000 - (Date.now() - submitted))),
      );
    }
    await page.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll<HTMLElement>('[role="button"],button')];
        return buttons.some(
          (button) =>
            /^(保存|Save)$/i.test((button.textContent ?? "").trim()) &&
            (button.getAttribute("aria-disabled") === "true" || button.hasAttribute("disabled")),
        );
      },
      undefined,
      { timeout: 30_000 },
    );
  }
  await assertActive();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await save.waitFor({ state: "visible", timeout: 60_000 });
  if (await more.isVisible()) await more.click();
  await verified(page);
}
