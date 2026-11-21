import type { Locator } from "playwright";

const optionTimeoutMs = 2_000;
const maxAttempts = 3;

export function getPromoteDataAnalysisExactLabelPattern(label: string): RegExp {
  const escapedLabel = label
    .replace(/\s+/gu, "")
    .split("")
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(`^\\s*${escapedLabel}\\s*$`, "u");
}

async function readOptionState(row: Locator): Promise<boolean | undefined> {
  return row
    .evaluate(
      (element) => {
        const input = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (input) return input.checked;
        const control = element.querySelector('[role="checkbox"]') ?? element;
        const checked = control.getAttribute("aria-checked");
        return checked === "true" ? true : checked === "false" ? false : undefined;
      },
      undefined,
      { timeout: optionTimeoutMs },
    )
    .catch(() => undefined);
}

// Require a stable state: a pending clear/render must not be mistaken for a
// successful selection. Always re-read before retrying to avoid toggling back.
async function waitForStableState(
  matches: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let matchedSince: number | undefined;
  while (Date.now() < deadline) {
    if (await matches()) {
      matchedSince ??= Date.now();
      if (Date.now() - matchedSince >= 200) return true;
    } else {
      matchedSince = undefined;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function clearPromoteDataAnalysisDimensions(scope: Locator): Promise<void> {
  const isCleared = () =>
    scope.locator("div.inline-flex.cursor-pointer:visible").evaluateAll((rows) => {
      const options = rows.filter(
        (row) =>
          row.matches("[aria-checked]") ||
          row.querySelector('input[type="checkbox"], [role="checkbox"]'),
      );
      return (
        options.length > 0 &&
        options.every((row) => {
          const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
          if (input) return !input.checked;
          const control = row.querySelector('[role="checkbox"]') ?? row;
          return control.getAttribute("aria-checked") === "false";
        })
      );
    });
  // Avoid scheduling another asynchronous clear when the panel is already empty.
  if ((await isCleared()) && (await waitForStableState(isCleared, 400))) return;
  await scope.getByText("清空", { exact: true }).first().click({ timeout: 60_000 });
  const cleared = await waitForStableState(isCleared, 10_000);
  if (!cleared) throw new Error("标准看板维度清空后未完成状态更新");
}

export async function setPromoteDataAnalysisOption(
  scope: Locator,
  label: string,
  selected: boolean,
): Promise<void> {
  // Exact, visible matches avoid both overlapping names (视频/短视频…) and
  // hidden copies left mounted by the platform.
  const pattern = getPromoteDataAnalysisExactLabelPattern(label);
  const row = scope
    .locator("div.inline-flex.cursor-pointer:visible")
    .filter({ hasText: pattern })
    .last();
  await row.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {
    throw new Error(`标准看板字段配置中未找到“${label}”`);
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await waitForStableState(async () => (await readOptionState(row)) === selected, 400)) {
      return;
    }
    const current = await readOptionState(row);
    if (current === undefined) {
      lastError = new Error(`无法读取“${label}”的选中状态`);
      continue;
    }
    if (current === selected) continue;

    try {
      const checkbox = row.locator('input[type="checkbox"]').first();
      const text = row.getByText(pattern).last();
      if (attempt === 1 && (await checkbox.isVisible())) {
        // Target the input itself instead of an arbitrary point in its wrapper.
        await checkbox.setChecked(selected, { timeout: optionTimeoutMs });
      } else if (await text.isVisible()) {
        // Custom controls can hide the input or handle selection on the label.
        await text.click({ timeout: optionTimeoutMs });
      } else {
        await row.click({ timeout: optionTimeoutMs });
      }
    } catch (error) {
      lastError = error;
    }
    if (
      await waitForStableState(
        async () => (await readOptionState(row)) === selected,
        optionTimeoutMs,
      )
    ) {
      return;
    }
  }

  const current = await readOptionState(row);
  throw new Error(
    `标准看板字段“${label}”未能${selected ? "选中" : "取消选中"}（已尝试 ${maxAttempts} 次，当前状态：${String(current)}${lastError instanceof Error ? `，${lastError.message}` : ""}）`,
  );
}
