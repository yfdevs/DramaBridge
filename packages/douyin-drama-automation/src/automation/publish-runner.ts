import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import type { Page } from "playwright";
import {
  DOUYIN_DRAMA_CREATE_URL,
  DOUYIN_DRAMA_FRAMEWORK_CONTRACT_ID,
  DOUYIN_DRAMA_FRAMEWORK_CONTRACT_NAME,
  DOUYIN_DRAMA_PRODUCTION_COST_RANGE,
  DOUYIN_DRAMA_STANDARD_CONTRACT_NAME,
  DOUYIN_DRAMA_UPDATE_STATUS,
} from "../shared/constants.js";
import {
  createDouyinDramaDropdownRecorder,
  type DouyinDramaDropdownRecorder,
} from "../shared/dropdown-options.js";
import { errorLog, log } from "../shared/logger.js";
import { douyinDramaLocalRoot, douyinDramaResourceName } from "../shared/resources.js";
import type { ClaimedDouyinDramaTask, DouyinDramaRuntimeOptions } from "../shared/types.js";
import { waitForDouyinDramaCreatePageReady } from "./browser-session.js";
import { prepareShortDouyinEpisodeVideos } from "./episode-speed.js";
import {
  addDouyinRole,
  assertNoDouyinFormError,
  clickDouyinNext,
  douyinFormItem,
  fillDouyinSeriesDialog,
  fillDouyinEpisodeBatchEdit,
  fillNearestDouyinCompletionPromiseDateTime,
  fillDouyinPublishDateTime,
  hasInvalidDouyinEpisodeDuration,
  hasTooShortDouyinEpisodeDuration,
  fillInputById,
  fillStableInputById,
  installDouyinPageMessageCapture,
  resetRestoredDouyinFormIfPresent,
  reuploadFailedDouyinEpisodeAfterDelete,
  sanitizeDouyinDescriptionText,
  selectDropdownByPlaceholder,
  selectDropdownValues,
  selectDouyinChargeEpisodes,
  selectFirstDropdownByPlaceholder,
  selectRadio,
  selectRequiredDropdownByContractName,
  selectRequiredDropdownByStableId,
  selectSearchableDropdownByPlaceholder,
  selectVisibleRadio,
  uploadFormFiles,
} from "./form-controls.js";

export function locateDouyinEpisodeUploadControls(page: Page) {
  const panel = page
    .locator([
      ".edit-page-video-upload-shortplay:visible",
      ".edit-page-video-upload-shortplay-container:visible",
    ].join(", "))
    .filter({ has: page.locator('input[type="file"][multiple]') })
    .first();
  const input = panel.locator('input[type="file"][multiple][accept*=".mp4"]').first();
  return { input, panel };
}

type DouyinAutomationAction = <T>(name: string, action: () => Promise<T>) => Promise<T>;

const episodeUploadPollIntervalMs = 5_000;
const postSubmitSettleMs = 15_000;
const salesConfigurationSelector = [
  "#complete_promise_time input",
  'input[placeholder="请选择更新完成时间"]',
  "#complete_promise_time_input",
  "#unit_price_input",
  "#charge_episode",
].join(", ");

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logValue(value: unknown) {
  const text = Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("、")
    : typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  const compact = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(compact.length > 160 ? `${compact.slice(0, 157)}...` : compact);
}

function fileNames(files: string[]) {
  return files.length > 0 ? files.map((file) => path.basename(file)).join("、") : "无文件，跳过";
}

function createActionRunner(page: Page, options: DouyinDramaRuntimeOptions): DouyinAutomationAction {
  return async <T>(name: string, action: () => Promise<T>) => {
    log(options, `[douyin-drama] 脚本操作开始：${name}`, { action: name, url: page.url() }, "automation");
    try {
      await installDouyinPageMessageCapture(page);
      const result = await action();
      await installDouyinPageMessageCapture(page);
      await assertNoDouyinFormError(page, name);
      log(options, `[douyin-drama] 脚本操作完成：${name}`, { action: name, url: page.url() }, "automation");
      return result;
    } catch (error) {
      let failure = error;
      try {
        await installDouyinPageMessageCapture(page);
        await assertNoDouyinFormError(page, name);
      } catch (pageError) {
        failure = pageError;
      }
      errorLog(
        options,
        `[douyin-drama] 脚本操作失败：${name}；url=${page.url()}；错误=${errorMessage(failure)}`,
        { action: name, url: page.url(), error: failure },
        "automation",
      );
      throw failure;
    }
  };
}

export async function enterDouyinBasicInformation(
  page: Page,
  runAction: DouyinAutomationAction = async (_name, action) => action(),
) {
  // Wait for a real form control: all step titles are present even on the first step.
  await page.locator("#has_associate_clue:visible, #book_name_input:visible")
    .first().waitFor({ state: "visible", timeout: 30_000 });
  if (await page.locator("#has_associate_clue").isVisible()) {
    await runAction("选择是否关联线索=否", () => selectRadio(page, "是否关联线索", "否"));
    await runAction("关联线索点击下一步", () => clickDouyinNext(page));
  }
  await page.locator("#book_name_input").waitFor({ state: "visible", timeout: 30_000 });
}

async function fillBasicInformation(
  page: Page,
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  runAction: DouyinAutomationAction,
  recorder: DouyinDramaDropdownRecorder,
) {
  const data = task.playlet;
  const sanitizedSummary = sanitizeDouyinDescriptionText(data.summary);
  if (sanitizedSummary.length <= 100) {
    throw new Error(
      `DOUYIN_DRAMA_SUMMARY_TOO_SHORT_AFTER_SANITIZE: actual=${sanitizedSummary.length}`,
    );
  }
  await runAction(`填写作品名称=${logValue(data.title)}`, () =>
    fillInputById(page, "book_name_input", data.title));
  await runAction(`填写作品简介=${logValue(sanitizedSummary)}`, () =>
    fillInputById(page, "abstract_input", sanitizedSummary));
  if (!data.localHongguoCoverFile || !data.localDouyinCoverFile) {
    throw new Error("DOUYIN_DRAMA_COVER_FILE_REQUIRED");
  }
  await runAction(`上传红果封面图=${logValue(data.localHongguoCoverFile)}`, () =>
    uploadFormFiles(page, "红果封面图", [data.localHongguoCoverFile!]));
  await runAction(`上传抖音封面图=${logValue(data.localDouyinCoverFile)}`, () =>
    uploadFormFiles(page, "抖音封面图", [data.localDouyinCoverFile!]));
  await runAction(`填写承诺总集数=${data.episodeCount}`, () =>
    fillInputById(page, "final_chapter_number_input", data.episodeCount));
  await runAction(`选择更新状态=${DOUYIN_DRAMA_UPDATE_STATUS}`, () =>
    selectRadio(page, "更新状态", DOUYIN_DRAMA_UPDATE_STATUS));
  await runAction(`选择是否AI作品=${data.isAi ? "是" : "否"}`, () =>
    selectRadio(page, "是否AI作品", data.isAi ? "是" : "否"));
  if (data.isAi) {
    await runAction(`选择关联AIGC工具=${logValue(data.aigcTools)}`, () =>
      selectDropdownValues(page, "关联AIGC工具", data.aigcTools, recorder));
  }
  await runAction(`选择分类=${logValue(data.categories)}`, () =>
    selectDropdownValues(page, "分类", data.categories, recorder));
  await runAction(`选择男女频=${data.audience}`, () =>
    selectRadio(page, "男女频", data.audience));
  await runAction(`选择是否系列剧=${data.isSeries ? "是" : "否"}`, () =>
    selectRadio(page, "是否系列剧", data.isSeries ? "是" : "否"));
  if (data.isSeries) {
    await runAction("填写系列剧信息（季播剧，复用剧名、红果封面和简介）", () =>
      fillDouyinSeriesDialog(page, {
        coverFile: data.localHongguoCoverFile!,
        summary: sanitizedSummary,
        title: data.title,
      }));
  }
  await runAction(`选择版权专区IP改编=${data.isCopyrightIpAdaptation ? "是" : "否"}`, () =>
    selectRadio(page, "版权专区IP改编", data.isCopyrightIpAdaptation ? "是" : "否"));
  if (data.isCopyrightIpAdaptation && data.copyrightIpName) {
    await runAction(`选择版权IP=${logValue(data.copyrightIpName)}`, () =>
      selectSearchableDropdownByPlaceholder(
        page,
        "请选择已审核通过的IP申请记录",
        "copyrightIp",
        data.copyrightIpName!,
        recorder,
      ));
  }
  await runAction(`填写制作机构=${logValue(data.productionOrganization)}`, () =>
    fillInputById(page, "production_company_input", data.productionOrganization));
  await runAction(`填写制片人=${logValue(data.producers)}`, () =>
    fillInputById(page, "producer_input", data.producers.join("，")));
  await runAction(`填写导演=${logValue(data.directors)}`, () =>
    fillInputById(page, "director_input", data.directors.join("，")));
  if (data.screenwriters.length > 0) {
    await runAction(`填写编剧=${logValue(data.screenwriters)}`, () =>
      fillInputById(page, "script_writer_input", data.screenwriters.join("，")));
  }
  for (const [index, role] of data.roles.entries()) {
    await runAction(`添加角色[${index + 1}/${data.roles.length}]=${logValue(role.name)}`, () =>
      addDouyinRole(page, role));
  }
  await runAction(`选择制作金额范围=${DOUYIN_DRAMA_PRODUCTION_COST_RANGE}`, () =>
    selectRadio(page, "制作金额范围", DOUYIN_DRAMA_PRODUCTION_COST_RANGE));
  const costConfigurationFile = data.costConfigurationFiles.slice(0, 1);
  await runAction(`上传成本配置情况=${fileNames(costConfigurationFile)}`, () =>
    uploadFormFiles(page, "成本配置情况", costConfigurationFile));
  await runAction(`填写剧目制作成本=${data.productionCostWan}万元`, () =>
    fillStableInputById(page, "cost_price_input", data.productionCostWan));
  if (data.payCommitmentFiles.length > 0) {
    const payCommitmentItem = douyinFormItem(page, "片酬承诺书");
    if (await payCommitmentItem.isVisible().catch(() => false)) {
      await runAction(`上传片酬承诺书=${fileNames(data.payCommitmentFiles)}`, () =>
        uploadFormFiles(page, "片酬承诺书", data.payCommitmentFiles));
    } else {
      log(
        options,
        "[douyin-drama] 当前表单未展示片酬承诺书上传项，已跳过该可选材料",
        { files: fileNames(data.payCommitmentFiles) },
        "upload",
      );
    }
  }
  const contractPlaceholder = "请选择（温馨提示：合同绑定错误会影响结算）";
  const selectedContractName = data.contractName?.trim();
  if (selectedContractName) {
    const contractId = /^CT\d+/u.exec(selectedContractName)?.[0];
    if (!contractId) {
      throw new Error(`DOUYIN_DRAMA_CONTRACT_ID_INVALID: contractName=${selectedContractName}`);
    }
    await runAction(`选择后台指定合同=${selectedContractName}`, () =>
      selectRequiredDropdownByStableId(
        page,
        contractPlaceholder,
        "contract",
        contractId,
        recorder,
      ));
  } else if (data.isCopyrightIpAdaptation) {
    await runAction(`旧任务兼容选择绑定合同=${DOUYIN_DRAMA_FRAMEWORK_CONTRACT_NAME}`, () =>
      selectRequiredDropdownByStableId(
        page,
        contractPlaceholder,
        "contract",
        DOUYIN_DRAMA_FRAMEWORK_CONTRACT_ID,
        recorder,
      ));
  } else {
    await runAction(`旧任务兼容选择绑定合同=${DOUYIN_DRAMA_STANDARD_CONTRACT_NAME}`, () =>
      selectRequiredDropdownByContractName(
        page,
        contractPlaceholder,
        "contract",
        DOUYIN_DRAMA_STANDARD_CONTRACT_NAME,
        recorder,
      ));
  }
  await runAction(`上传权属文件=${fileNames(data.ownershipProofFiles)}`, () =>
    uploadFormFiles(page, "权属文件", data.ownershipProofFiles, 120_000, "copyright_files_input"));
  await runAction(`上传不侵权承诺函=${fileNames(data.nonInfringementCommitmentFiles)}`, () =>
    uploadFormFiles(
      page,
      "不侵权承诺函",
      data.nonInfringementCommitmentFiles,
      120_000,
      "non_infringement_letter_url_input",
    ));
  await runAction(`上传工程文件截图=${fileNames(data.projectScreenshotFiles)}`, () =>
    uploadFormFiles(
      page,
      "工程文件截图",
      data.projectScreenshotFiles,
      120_000,
      "engineering_file_screenshots_input",
    ));
  await runAction("基本信息点击下一步", () => clickDouyinNext(page));
}

async function uploadEpisodes(
  page: Page,
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  runAction: DouyinAutomationAction,
) {
  const uploadRootDir = options.assetDownloadDir ?? path.resolve(process.cwd(), ".drama-runs/douyin-drama/assets");
  await mkdir(uploadRootDir, { recursive: true });
  const prepared = await runAction(`准备剧集视频=${task.playlet.episodeCount}集`, () =>
    prepareEpisodeUploadFiles({
      localEpisodeVideoRoot: douyinDramaLocalRoot(options),
      resourceName: douyinDramaResourceName(task),
      uploadRootDir,
      uploadBaseName: task.playlet.title,
    }));
  try {
    await runAction("检查短视频并执行0.9倍速处理", () =>
      prepareShortDouyinEpisodeVideos(prepared.files, {
        thresholdSeconds: 30,
        speed: 0.9,
        concurrency: 2,
        sourceFiles: prepared.sourceFiles,
        onLog: (message) => log(options, message, { accountTaskId: task.accountTaskId }, "upload"),
      }));
    const timeout = Math.max(1, options.episodeUploadWaitTimeoutMinutes ?? 120) * 60_000;
    const maximumReuploadAttempts = Math.max(
      0,
      Math.floor(options.episodeUploadReplaceAttempts ?? 5),
    );
    const uploadBatchSize = Math.max(
      1,
      Math.min(50, Math.floor(options.episodeUploadBatchSize ?? 3)),
    );
    const { input, panel } = locateDouyinEpisodeUploadControls(page);
    await panel.waitFor({ state: "visible", timeout: 15_000 });
    await input.waitFor({ state: "attached", timeout: 15_000 });
    const deadline = Date.now() + timeout;
    const reuploadAttemptsByFile = new Map<string, number>();
    const initialFiles = prepared.files.slice(0, uploadBatchSize);
    let selectedCount = initialFiles.length;
    await runAction(
      `启动剧集视频滑动上传，并行=${uploadBatchSize}，首轮=${initialFiles.length}个文件`,
      () => input.setInputFiles(initialFiles, { timeout: 120_000 }),
    );
    await runAction(
      `保持最多${uploadBatchSize}个剧集视频上传，完成一个立即补充一个`,
      async () => {
        let lastStatus = "";
        let settledPasses = 0;
        while (Date.now() < deadline) {
          await assertNoDouyinFormError(page, "等待剧集上传完成");
          const items = panel.locator(".uploaded_list_item");
          const visibleCount = await items.count();
          const completedCount = await items
            .locator(".file-status-text-success")
            .filter({ hasText: /上传完成|处理完成|转码完成/u })
            .count();
          const failedCount = await items
            .locator(".file-status-text-error")
            .filter({ hasText: /上传失败|处理失败|转码失败|上传异常/u })
            .count();
          const invalidDurationCount = (await items.allInnerTexts())
            .filter(hasInvalidDouyinEpisodeDuration)
            .length;
          const tooShortDurationCount = (await items.allInnerTexts())
            .filter(hasTooShortDouyinEpisodeDuration)
            .length;
          if (failedCount > 0 || invalidDurationCount > 0 || tooShortDurationCount > 0) {
            const reuploaded = await reuploadFailedDouyinEpisodeAfterDelete(
              panel,
              input,
              prepared.files,
              maximumReuploadAttempts,
              reuploadAttemptsByFile,
            );
            for (const retry of reuploaded) {
              log(
                options,
                `[douyin-drama] 剧集视频上传失败或时长异常，已删除异常条目并重新上传：${retry.fileName} ` +
                  `第${retry.attempt}/${maximumReuploadAttempts}次`,
                retry,
                "automation",
              );
            }
            settledPasses = 0;
            await page.waitForTimeout(episodeUploadPollIntervalMs);
            continue;
          }

          const uploadingCount = Math.max(0, selectedCount - completedCount);
          const availableSlots = Math.max(0, uploadBatchSize - uploadingCount);
          if (availableSlots > 0 && selectedCount < prepared.files.length) {
            const nextFiles = prepared.files.slice(
              selectedCount,
              Math.min(prepared.files.length, selectedCount + availableSlots),
            );
            await input.setInputFiles(nextFiles, { timeout: 120_000 });
            selectedCount += nextFiles.length;
            settledPasses = 0;
            log(
              options,
              `[douyin-drama] 上传槽位已释放，立即补充 ${nextFiles.length} 集：` +
                `已选择=${selectedCount}/${prepared.files.length}，并行上限=${uploadBatchSize}`,
              { files: nextFiles.map((file) => path.basename(file)) },
              "automation",
            );
          }

          const status = `已选择=${selectedCount}/${prepared.files.length}，` +
            `已出现=${visibleCount}/${selectedCount}，已完成=${completedCount}/${prepared.files.length}，` +
            `上传中=${Math.max(0, selectedCount - completedCount)}/${uploadBatchSize}`;
          if (status !== lastStatus) {
            lastStatus = status;
            log(options, `[douyin-drama] 剧集上传进度：${status}`, undefined, "automation");
          }
          const allCompleted = selectedCount >= prepared.files.length
            && visibleCount >= prepared.files.length
            && completedCount >= prepared.files.length;
          settledPasses = allCompleted ? settledPasses + 1 : 0;
          if (settledPasses >= 2) return;
          await page.waitForTimeout(episodeUploadPollIntervalMs);
        }
        throw new Error(
          `DOUYIN_DRAMA_EPISODE_UPLOAD_TIMEOUT: timeoutMinutes=${timeout / 60_000}; ${lastStatus}`,
        );
      },
    );
  } finally {
    await runAction("清理剧集上传临时文件", () => cleanupEpisodeUploadFiles(prepared));
  }
  if (!task.playlet.localDouyinCoverFile) {
    throw new Error("DOUYIN_DRAMA_BATCH_EDIT_COVER_REQUIRED");
  }
  await runAction(
    `批量编辑剧集=第1集至第${task.playlet.episodeCount}集，标题=${logValue(task.playlet.title)}`,
    () => fillDouyinEpisodeBatchEdit(page, {
      coverFile: task.playlet.localDouyinCoverFile!,
      episodeCount: task.playlet.episodeCount,
      title: task.playlet.title,
    }),
  );
  await runAction("视频上传页点击下一步", () => clickDouyinNext(page));
}

async function fillPublishConfiguration(
  page: Page,
  task: ClaimedDouyinDramaTask,
  runAction: DouyinAutomationAction,
  recorder: DouyinDramaDropdownRecorder,
) {
  const data = task.playlet;
  const brandAccountPlaceholder = "请选择（选择授权中的红果厂牌账号，仅支持选1个）";
  if (data.brandAccountName) {
    await runAction(`选择红果厂牌账号=${logValue(data.brandAccountName)}`, () =>
      selectDropdownByPlaceholder(
        page,
        brandAccountPlaceholder,
        "brandAccount",
        data.brandAccountName!,
        recorder,
      ));
  } else {
    await runAction("未指定红果厂牌账号，选择第一个可用厂牌账号并记录下拉", async () => {
      const selected = await selectFirstDropdownByPlaceholder(
        page,
        brandAccountPlaceholder,
        "brandAccount",
        recorder,
      );
      return selected;
    });
  }
  await runAction(`选择发布方式=${data.publishMode}`, () =>
    selectVisibleRadio(page, data.publishMode));
  if (data.publishMode === "自主发布") {
    const placeholder = "请选择（B号每日正片发布限额2000，C号每日正片发布限额75）";
    if (data.publishAccountName) {
      await runAction(`选择发布账号=${logValue(data.publishAccountName)}`, () =>
        selectSearchableDropdownByPlaceholder(
          page,
          placeholder,
          "publishAccount",
          data.publishAccountName!,
          recorder,
        ));
    } else {
      await runAction("未指定发布账号，选择第一个可用账号并记录下拉", async () => {
        const selected = await selectFirstDropdownByPlaceholder(
          page,
          placeholder,
          "publishAccount",
          recorder,
        );
        return selected;
      });
    }
  }
  await runAction(`设置发布时间=${logValue(data.scheduledPublishAt)}`, () =>
    fillDouyinPublishDateTime(page, data.scheduledPublishAt));
  await runAction("进入销售配置表单", () => enterSalesConfiguration(page));
}

export async function enterSalesConfiguration(page: Page) {
  const salesConfiguration = page.locator(salesConfigurationSelector).filter({ visible: true });
  if (await salesConfiguration.count() > 0) return;

  // 抖音同时存在同页表单和旧版分步表单。仅在销售字段尚未出现时推进到下一步，
  // 避免同页表单已经渲染后仍等待一个不存在的“下一步”按钮。
  await clickDouyinNext(page);
  await salesConfiguration.first().waitFor({ state: "visible", timeout: 15_000 });
}

async function fillSalesConfiguration(
  page: Page,
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  runAction: DouyinAutomationAction,
) {
  const unitPriceYuan = task.playlet.unitPriceYuan ?? options.unitPriceYuan ?? 0.5;
  const paidEpisodeStart = task.playlet.paidEpisodeStart ?? options.paidEpisodeStart ?? 10;
  if (!Number.isFinite(unitPriceYuan) || unitPriceYuan < 0.1 || unitPriceYuan > 9_999) {
    throw new Error(`DOUYIN_DRAMA_UNIT_PRICE_INVALID: ${unitPriceYuan}`);
  }

  await runAction("设置最近可用的更新完成时间", () =>
    fillNearestDouyinCompletionPromiseDateTime(page));
  await runAction(`填写单集售价=${unitPriceYuan}元`, () =>
    fillStableInputById(page, "unit_price_input", unitPriceYuan));
  await runAction(
    `选择售卖集数=第${paidEpisodeStart}集至第${task.playlet.episodeCount}集`,
    () => selectDouyinChargeEpisodes(page, paidEpisodeStart, task.playlet.episodeCount),
  );
}

export async function waitForDouyinSubmitSuccess(
  page: Page,
  submittedAt: number,
  options: { settleMs?: number; timeoutMs?: number } = {},
) {
  const settleMs = options.settleMs ?? postSubmitSettleMs;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const deadline = submittedAt + timeoutMs;
  while (Date.now() < deadline) {
    await assertNoDouyinFormError(page, "提交抖音漫剧");
    // The platform does not consistently render a success toast or redirect.
    // Treat a 15-second error-free settle window after the confirmed submit
    // click as success.
    if (Date.now() - submittedAt >= settleMs) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`DOUYIN_DRAMA_SUBMIT_SUCCESS_NOT_VERIFIED: url=${page.url()}`);
}

export async function runDouyinDramaPublishTask(
  page: Page,
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
) {
  const runAction = createActionRunner(page, options);
  const recorder = createDouyinDramaDropdownRecorder(options);
  await recorder.record("initial-static-options", []);
  log(
    options,
    `[douyin-drama] 发布脚本开始：taskId=${task.accountTaskId}，剧名=${logValue(task.playlet.title)}`,
    { accountTaskId: task.accountTaskId, title: task.playlet.title },
    "publish",
  );
  try {
    await runAction(`打开抖音上传漫剧页=${DOUYIN_DRAMA_CREATE_URL}`, async () => {
      await page.goto(DOUYIN_DRAMA_CREATE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForDouyinDramaCreatePageReady(page);
    });
    await runAction("检查并清空页面同步的上次填写内容", async () => {
      const reset = await resetRestoredDouyinFormIfPresent(page);
      if (reset) await waitForDouyinDramaCreatePageReady(page);
      log(
        options,
        reset
          ? "[douyin-drama] 已重置页面自动恢复的上次填写内容。"
          : "[douyin-drama] 页面没有恢复旧草稿，继续填写。",
        { accountTaskId: task.accountTaskId, reset },
        "automation",
      );
    });
    await enterDouyinBasicInformation(page, runAction);
    await fillBasicInformation(page, task, options, runAction, recorder);
    await uploadEpisodes(page, task, options, runAction);
    await fillPublishConfiguration(page, task, runAction, recorder);
    await fillSalesConfiguration(page, task, options, runAction);

    if (!task.playlet.submit) {
      log(
        options,
        "[douyin-drama] 发布脚本完成：submit=false，已填写并上传，停留在提交确认页。",
        { accountTaskId: task.accountTaskId, submitted: false },
        "publish",
      );
      return;
    }
    await runAction("提交抖音漫剧", async () => {
      const submitButton = page
        .getByRole("button", { name: /提交|确认提交|完成/ })
        .filter({ visible: true })
        .last();
      await submitButton.waitFor({ state: "visible", timeout: 15_000 });
      const submittedAt = Date.now();
      await submitButton.click();
      const confirm = page
        .getByRole("button", { name: /确定|确认提交/ })
        .filter({ visible: true })
        .last();
      if (await confirm.waitFor({ state: "visible", timeout: 3_000 }).then(() => true).catch(() => false)) {
        await confirm.click();
      }
      await waitForDouyinSubmitSuccess(page, submittedAt);
    });
    log(
      options,
      "[douyin-drama] 发布脚本完成：已提交。",
      { accountTaskId: task.accountTaskId, submitted: true },
      "publish",
    );
  } catch (error) {
    errorLog(
      options,
      `[douyin-drama] 发布脚本失败：taskId=${task.accountTaskId}；url=${page.url()}；错误=${errorMessage(error)}`,
      { accountTaskId: task.accountTaskId, url: page.url(), error },
      "publish",
    );
    throw error;
  }
}
