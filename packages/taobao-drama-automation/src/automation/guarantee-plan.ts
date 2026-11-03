import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import type { TaobaoCollectionMetadata } from "../shared/types.js";

async function selectPlanRadio(page: Page, id: string, text: string) {
  const label = page.locator(`#${id}`).locator("label").filter({ hasText: text }).first();
  await label.waitFor({ state: "visible", timeout: 15_000 });
  const input = label.locator('input[type="radio"]');
  if (!(await input.isChecked())) await label.click();
  if (!(await input.isChecked())) throw new Error(`TAOBAO_DRAMA_PLAN_RADIO_NOT_SELECTED: ${id}=${text}`);
}

export async function fillTaobaoGuaranteePlan(
  page: Page,
  data: TaobaoCollectionMetadata,
) {
  const plan = data.guaranteePlanType ?? "暂不参与";
  await selectPlanRadio(page, "guaranteePlanType", plan);
  if (plan === "暂不参与") return;
  if (!data.offsiteRankPlatform || !data.offsiteRankScreenshotUrls?.length) {
    throw new Error("TAOBAO_DRAMA_GUARANTEE_PLAN_MATERIAL_REQUIRED: 请选择上榜站外平台并上传截图");
  }
  await selectPlanRadio(page, "offsiteRankPlatform", data.offsiteRankPlatform);
  const field = page.locator('.next-form-item').filter({ has: page.locator('label[for="offsiteRankScreenshotUrls"]') });
  const input = field.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 15_000 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "dramabridge-taobao-rank-"));
  try {
    for (const [index, url] of data.offsiteRankScreenshotUrls.entries()) {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`TAOBAO_DRAMA_RANK_IMAGE_DOWNLOAD_FAILED: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error("TAOBAO_DRAMA_RANK_IMAGE_SIZE_INVALID");
      const mime = response.headers.get("content-type")?.split(";")[0];
      const extension = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" } as Record<string, string>)[mime ?? ""]
        ?? path.extname(new URL(url).pathname).match(/^\.(?:png|jpe?g|webp|gif|bmp)$/i)?.[0] ?? ".png";
      const file = path.join(directory, `rank-${index}${extension}`);
      await writeFile(file, buffer);
      await input.setInputFiles(file);
      // Wait for the form's image count before proceeding to submission.
      await field.getByText(`${index + 1}/9`, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
