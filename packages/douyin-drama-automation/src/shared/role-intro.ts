export const DOUYIN_ROLE_INTRO_MIN_LENGTH = 10;
export const DOUYIN_ROLE_INTRO_MAX_LENGTH = 100;

export function douyinRoleIntroLength(intro: string | undefined) {
  return Array.from((intro ?? "").replace(/\s/gu, "")).length;
}

export function isDouyinRoleIntroValid(intro: string | undefined) {
  return douyinRoleIntroLength(intro) >= DOUYIN_ROLE_INTRO_MIN_LENGTH
    && (intro?.trim().length ?? 0) <= DOUYIN_ROLE_INTRO_MAX_LENGTH;
}

export function requireDouyinRoleIntro(name: string, intro: string | undefined) {
  if (!isDouyinRoleIntroValid(intro))
    throw new Error(`DOUYIN_DRAMA_ROLE_INTRO_INVALID: ${name}的人物简介须为10–100字，当前${douyinRoleIntroLength(intro)}字，请先完成 AI 补充`);
  return intro!.trim();
}
