export type CommercialPosterTextValidation = {
  titlePresent: boolean;
  titleReadable: boolean;
  titleSeverelyIncorrect: boolean;
  hasProhibitedOverlay: boolean;
  hasClearlyUnrelatedOrGibberishText: boolean;
  detectedTexts?: readonly string[];
  blockingIssues?: readonly string[];
  warnings?: readonly string[];
};

export type CommercialPosterTextValidationResult = {
  passed: boolean;
  failures: string[];
  warnings: string[];
};

export const commercialPosterSupportingCopyGuidance =
  "除完整准确的剧名外，禁止出现任何辅助文案、地点、年代、人物身份、角色、演员信息、剧情氛围词、宣传语或装饰性小字。";

export const commercialPosterProhibitedTextGuidance =
  "严格拦截任何额外文字、其他作品名称、随机乱码、联系方式、账号、广告引流、二维码、平台或品牌水印，以及画幅比例、尺寸、分辨率、像素值、相机参数、操作按钮、信息栏等技术或伪界面文字。";

export function normalizeCommercialPosterText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

export function isCommercialPosterTitleDetected(
  title: string,
  detectedTexts: readonly string[] = [],
) {
  const expected = normalizeCommercialPosterText(title);
  if (!expected) return false;
  const detected = detectedTexts.map(normalizeCommercialPosterText).filter(Boolean);
  if (detected.some((text) => text.includes(expected))) return true;

  let reachable = new Set([0]);
  for (const text of detected) {
    const next = new Set(reachable);
    for (const offset of reachable) {
      if (expected.startsWith(text, offset)) next.add(offset + text.length);
    }
    if (next.has(expected.length)) return true;
    reachable = next;
  }
  return false;
}

export function isNonBlockingCommercialPosterIssue(issue: string) {
  const normalized = issue.replace(/\s+/g, "");
  return /只出现一次|出现多次|多次出现|重复出现|多次重复/.test(normalized)
    || /标点|逗号|顿号|分行|换行|竖排/.test(normalized)
    || /辅助文案|地点文字|地点文案|年代文字|人物身份|角色信息|演员信息|剧情氛围|宣传语|装饰性小字/.test(normalized)
    || /(?:扬州|京城|民国).*(?:无关|多余|文字)|(?:无关|多余|文字).*(?:扬州|京城|民国)/.test(normalized);
}

function isClearlyBlockingCommercialPosterIssue(issue: string) {
  const normalized = issue.replace(/\s+/g, "");
  return /其他作品|另一部作品|剧名.*(?:错字|漏字|缺失)|(?:错字|漏字|缺失).*剧名|乱码|联系方式|手机号|微信号|账号|广告|引流|二维码|水印|平台标志|品牌标志|分辨率|尺寸标注|相机参数|操作按钮|信息栏|伪界面/.test(
    normalized,
  );
}

export function evaluateCommercialPosterTextValidation(
  title: string,
  validation: CommercialPosterTextValidation,
): CommercialPosterTextValidationResult {
  const exactTitleDetected = isCommercialPosterTitleDetected(
    title,
    validation.detectedTexts,
  );
  const reportedBlockingIssues = validation.blockingIssues ?? [];
  const blockingIssues = reportedBlockingIssues.filter(
    (issue) => !isNonBlockingCommercialPosterIssue(issue)
      && isClearlyBlockingCommercialPosterIssue(issue),
  );
  const downgradedIssues = reportedBlockingIssues.filter(
    (issue) => !blockingIssues.includes(issue),
  );
  const failures = [
    !validation.titlePresent && !exactTitleDetected && "未检测到完整剧名",
    !validation.titleReadable && !exactTitleDetected && "剧名主体无法清晰辨认",
    validation.titleSeverelyIncorrect && !exactTitleDetected && "剧名存在明显错字或漏字",
    validation.hasProhibitedOverlay && "检测到广告、水印、二维码或技术界面文字",
    validation.hasClearlyUnrelatedOrGibberishText && "检测到明显无关的其他作品文字或乱码",
    ...blockingIssues,
  ].filter((issue): issue is string => Boolean(issue));
  return {
    passed: failures.length === 0,
    failures,
    warnings: [...(validation.warnings ?? []), ...downgradedIssues],
  };
}
