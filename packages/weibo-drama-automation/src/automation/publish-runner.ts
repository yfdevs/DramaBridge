import type { BrowserContext, Page } from "playwright";
import { WEIBO_DRAMA_ADD_URL } from "../shared/constants.js";
import { weiboOptions } from "../shared/options.js";
import type { ClaimedWeiboDramaTask, WeiboDramaRuntimeOptions } from "../shared/types.js";
import {
  requireWeiboPublishAccount,
  saveCredentialState,
  waitForLoginIfNeeded,
} from "./browser-session.js";
import {
  expandWeiboEpisodeGrid,
  restoreWeiboEpisodeOrder,
  waitForWeiboEpisodeUploads,
} from "./episode-upload.js";
import { prepareWeiboEpisodeFiles } from "../shared/episode-materials.js";
import { withWeiboProgress } from "../shared/progress.js";
import { waitForWeiboAction } from "./action-result.js";
import { removeWeiboUploadItem } from "./remove-upload-item.js";
import { log } from "../shared/logger.js";
import {
  findExistingWeiboCollection,
  isWeiboCollectionComplete,
  openExistingWeiboCollection,
  readWeiboCollectionInfo,
  assertWeiboCollectionHasNoDuplicates,
  assertWeiboCollectionCanSubmit,
} from "./existing-collection.js";

export function weiboFormItem(page: Page, label: string) {
  return page
    .locator(".el-form-item")
    .filter({
      has: page.locator(".el-form-item__label").filter({ hasText: new RegExp(`^\\s*${label}`) }),
    })
    .first();
}
async function fill(page: Page, label: string, value: string | number) {
  const input = weiboFormItem(page, label).locator("input:not([type=file]),textarea").first();
  await input.fill(String(value));
  await input.blur();
}
async function select(page: Page, label: string, value: string) {
  await weiboFormItem(page, label).locator(".el-select__wrapper").click();
  await page
    .locator(".el-select__popper:visible")
    .getByRole("option", { name: value, exact: true })
    .click();
}
async function tag(page: Page, label: string, values: string[]) {
  const item = weiboFormItem(page, label);
  const current = await item.locator(".el-tag__content").allTextContents();
  if (current.length === values.length && current.every((value) => values.includes(value.trim())))
    return;
  while (await item.getByRole("button", { name: "关闭此标签", exact: true }).count())
    await item.getByRole("button", { name: "关闭此标签", exact: true }).first().click();
  await page.getByRole("heading", { name: "创建合集" }).click();
  await item.locator(".episode-custom-select").click();
  for (const value of values) {
    const panel = page.locator(".el-popover:visible");
    if (label === "情节主题") {
      const group = Object.entries(weiboOptions.theme_tag).find(([, children]) =>
        (children as readonly string[]).includes(value),
      );
      if (!group) throw new Error(`WEIBO_DRAMA_UNKNOWN_THEME: ${value}`);
      await panel.locator(".theme-tag-groups").getByText(group[0], { exact: true }).click();
      await panel.locator(".theme-tag-children").getByText(value, { exact: true }).click();
    } else {
      await panel.locator(".episode-tag-list").getByText(value, { exact: true }).click();
    }
  }
  await page.getByRole("heading", { name: "创建合集" }).click();
}

export async function fillWeiboVideoSubmissionFields(page: Page) {
  await select(page, "视频类型", "短剧正片");
  const declaration = weiboFormItem(page, "内容声明");
  await declaration.getByText("AI生成", { exact: true }).click();
  if (
    !(await weiboFormItem(page, "视频类型").innerText()).includes("短剧正片") ||
    !(await declaration.locator('input[type="radio"][value="AI生成"]').isChecked())
  )
    throw new Error(
      "WEIBO_DRAMA_FORM_VALIDATION_FAILED: 视频类型必须为短剧正片，内容声明必须为AI生成",
    );
}

export async function openWeiboDramaAddPage(
  page: Page,
  context: BrowserContext,
  options: WeiboDramaRuntimeOptions,
) {
  await page.goto(WEIBO_DRAMA_ADD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (await waitForLoginIfNeeded(page, context, options))
    await page.reload({ waitUntil: "domcontentloaded" });
  await weiboFormItem(page, "合集名称").locator("input").waitFor();
  await saveCredentialState(context, options);
}

export async function runWeiboDramaPublishTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedWeiboDramaTask,
  options: WeiboDramaRuntimeOptions,
) {
  await openWeiboDramaAddPage(page, context, options);
  const p = task.playlet;
  const publishAccount = await requireWeiboPublishAccount(page, options);
  const existing = await withWeiboProgress(options, "检查当前账号是否已有同名合集", () =>
    findExistingWeiboCollection(page, p.title, publishAccount.uid),
  );
  if (existing) {
    const info = await readWeiboCollectionInfo(page, String(existing.id));
    assertWeiboCollectionHasNoDuplicates(info, p.episodeCount);
    if (
      String(info.detail_info.id) !== String(existing.id) ||
      info.detail_info.name !== p.title ||
      String(info.detail_info.pub_uid) !== publishAccount.uid
    )
      throw new Error("WEIBO_DRAMA_COLLECTION_LOOKUP_FAILED: 合集身份不匹配，已停止编辑");
    if (isWeiboCollectionComplete(info, p.title, publishAccount.uid, p.episodeCount)) {
      log(
        options,
        `[weibo-drama] 同名合集已提交或已上线，全部剧集核验通过，复用合集 ${existing.id}`,
      );
      return { albumId: String(existing.id), title: p.title, episodeCount: p.episodeCount };
    }
    if (
      ![0, -1, -2].includes(Number(info.detail_info.status)) ||
      info.video_list.some((video) => [1, 2, 6].includes(Number(video.status)))
    )
      throw new Error(
        `WEIBO_DRAMA_COLLECTION_NOT_EDITABLE: 同名合集 ${existing.id} 存在审核中或已上线内容，无法直接编辑，请在微博确认剧集状态`,
      );
    log(options, `[weibo-drama] 找到同名合集 ${existing.id}，进入编辑继续发布`);
    await openExistingWeiboCollection(page, existing, publishAccount);
  }
  await fill(page, "合集名称", p.title);
  await select(page, "合集分类", p.collectionCategory);
  await select(page, "受众类型", p.audienceType);
  await tag(page, "题材类型", p.subjectTypes);
  await tag(page, "时代背景", [p.eraBackground]);
  await tag(page, "情节主题", p.plotThemes);
  await tag(page, "角色设定", p.roleSettings);
  await weiboFormItem(page, "合集封面")
    .locator("input[type=file]")
    .setInputFiles(p.localCoverFile!);
  await weiboFormItem(page, "合集封面").locator("img.cover").waitFor({ timeout: 120_000 });
  await fill(page, "合集总集数", p.episodeCount);
  await tag(page, "卡点集", ["第5集"]);
  await tag(page, "允许剪辑集数", ["全部"]);
  await fill(page, "平均单集时长", 1);
  await fill(page, "内容简介", p.summary);
  for (const label of ["版权方公司", "导演", "制作人", "编剧"]) await fill(page, label, "明星说");
  await weiboFormItem(page, "主要演员").getByText("无", { exact: true }).click();
  await select(page, "发布账号", publishAccount.name);
  // Editing loads saved certificates. Replace the list instead of appending past the five-file limit.
  const proof = weiboFormItem(page, "版权证明");
  while (await proof.locator(".el-upload-list__item").count()) {
    const item = proof.locator(".el-upload-list__item").first();
    await removeWeiboUploadItem(page, item, async () => {
      await item.hover();
      await item.getByRole("button", { name: "删除", exact: true }).click();
    });
  }
  await weiboFormItem(page, "版权证明").locator("input[type=file]").setInputFiles(p.ownershipFiles);
  await page.waitForFunction(
    (count) => document.querySelectorAll(".el-upload-list__item.is-success").length === count,
    p.ownershipFiles.length,
    { timeout: 180_000 },
  );
  await waitForWeiboAction(
    page,
    () => page.getByRole("button", { name: "下一步：上传视频", exact: true }).click(),
    page.waitForURL((url) => url.pathname === "/content/series/next", { timeout: 120_000 }),
    { signal: options.signal },
  );
  const albumId = new URL(page.url()).searchParams.get("album_id");
  if (!albumId) throw new Error("WEIBO_DRAMA_ALBUM_ID_MISSING");
  await page.getByText(`2. 上传视频《${p.title}》`, { exact: false }).waitFor({ timeout: 60_000 });
  await page.locator(".upload-card input[type=file]").waitFor({ state: "attached", timeout: 30_000 });
  const savedInfo = await readWeiboCollectionInfo(page, albumId);
  assertWeiboCollectionCanSubmit(savedInfo, albumId, p.title, publishAccount.uid, p.episodeCount);
  // Do not mistake an unhydrated list for an empty draft.
  if (savedInfo.video_list.length)
    await page.locator(".video-card").first().waitFor({ state: "attached", timeout: 15_000 });
  await expandWeiboEpisodeGrid(page);
  await page.waitForFunction(
    (count) => document.querySelectorAll(".video-card").length === count,
    savedInfo.video_list.length,
    { timeout: 15_000 },
  );
  // Fill as soon as this page opens, so long conversion/upload waits do not leave
  // the form looking unfinished. Recheck immediately before submitting as well.
  await fillWeiboVideoSubmissionFields(page);
  // Saved draft videos are explicitly replaced, rather than appended or silently duplicated.
  // Submitted/online episodes were rejected above and are never removed here.
  if (savedInfo.video_list.length) {
    await expandWeiboEpisodeGrid(page);
    for (let remaining = savedInfo.video_list.length; remaining > 0; remaining--) {
      options.signal?.throwIfAborted();
      const card = page.locator(".video-card").last();
      await removeWeiboUploadItem(page, card, async () => {
        await card.locator(".video-cover").hover();
        await card.locator(".close-btn").click();
      });
      if (await page.locator(".video-card").count() !== remaining - 1)
        throw new Error("WEIBO_DRAMA_UPLOAD_COUNT_INVALID: 清理旧视频后数量异常，已停止，避免重复上传");
    }
  }
  let added = 0;
  const prepared = await withWeiboProgress(
    options,
    "检查、转码和上传视频（合格剧集立即上传）",
    () =>
      prepareWeiboEpisodeFiles(task, options, async (file, episodeIndex) => {
        const previous = await page.locator(".video-card").count();
        if (previous !== added)
          throw new Error(`WEIBO_DRAMA_UPLOAD_COUNT_INVALID: 上传前页面已有${previous}集，预期${added}集；可能有旧视频或其他窗口正在操作，已停止上传`);
        await page.locator(".upload-card input[type=file]").setInputFiles(file);
        await page.waitForFunction(
          (count) => document.querySelectorAll(".video-card").length === count,
          previous + 1,
          { timeout: 15_000 },
        );
        // The site's before-upload counter resets 200 ms after each selection.
        // Let it reset before selecting another file, or it double-counts the
        // previous selection and rejects the final episodes as over the limit.
        await page.waitForTimeout(250);
        added++;
        log(
          options,
          `[weibo-drama] 第${episodeIndex}集已就绪并加入上传，已加入${previous + 1}/${p.episodeCount}集，其余剧集继续检查和转码`,
        );
      }),
    {
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      episodeCount: p.episodeCount,
    },
  );
  try {
    await waitForWeiboEpisodeUploads(page, prepared.uploadOrderFiles, options);
    await withWeiboProgress(options, "按集号整理并核对上传顺序", () =>
      restoreWeiboEpisodeOrder(page, prepared.uploadOrderFiles, prepared.files, options),
    );
    await fillWeiboVideoSubmissionFields(page);
    // The UI may have been open for hours while another run submitted this album.
    // Recheck server state immediately before the non-idempotent final action.
    assertWeiboCollectionCanSubmit(
      await readWeiboCollectionInfo(page, albumId),
      albumId, p.title, publishAccount.uid, p.episodeCount,
    );
    log(options, `[weibo-drama] 提交审核前后台查重通过：合集 ${albumId}，${p.episodeCount}集`);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/creator/video/update") && response.request().method() === "POST",
      { timeout: 120_000 },
    );
    const submittedAt = Date.now();
    // Even a failed response keeps the page open for the minimum settle period.
    try {
      const response = await waitForWeiboAction(
        page,
        () => page.getByRole("button", { name: "提交审核", exact: true }).click(),
        responsePromise,
        { signal: options.signal },
      );
      const result = await response.json();
      if (
        !response.ok() ||
        result.status !== 0 ||
        !(result.data?.insert_data || result.data?.update_data)
      )
        throw new Error(`WEIBO_DRAMA_SUBMIT_FAILED: ${result.msg ?? response.status()}`);
      await page.waitForURL((url) => url.pathname === "/content/series", { timeout: 60_000 });
      // Verify the specific collection and all episodes through the authenticated read endpoint.
      let verified = false;
      const verificationDeadline = Date.now() + 60_000;
      while (!verified && Date.now() < verificationDeadline) {
        verified = await page.evaluate(
          async ({ albumId, count, title, accountId }) => {
            const token = localStorage.getItem("token");
            const response = await fetch(
              `https://api-duanju.weibo.com/creator/album/info?id=${encodeURIComponent(albumId)}`,
              {
                credentials: "include",
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(10_000),
              },
            );
            const result = await response.json();
            const videos = result.data?.video_list as
              | Array<{ status: number; index_num: number }>
              | undefined;
            return (
              result.status === 0 &&
              result.data?.detail_info?.name === title &&
              String(result.data?.detail_info?.pub_uid) === accountId &&
              videos?.length === count &&
              videos.every((video) => [2, 6].includes(Number(video.status))) &&
              videos
                .map((video) => Number(video.index_num))
                .sort((a, b) => a - b)
                .every((value, index) => value === index + 1)
            );
          },
          { albumId, count: p.episodeCount, title: p.title, accountId: publishAccount.uid },
        );
        if (!verified) await page.waitForTimeout(2_000);
      }
      if (!verified) throw new Error("WEIBO_DRAMA_RECOGNIZE_RESULT_FAILED: 合集剧集审核状态未确认");
      return { albumId, title: p.title, episodeCount: p.episodeCount };
    } finally {
      await page.waitForTimeout(Math.max(0, 10_000 - (Date.now() - submittedAt)));
    }
  } finally {
    await prepared.cleanup();
  }
}
