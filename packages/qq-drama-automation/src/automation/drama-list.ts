import type { BrowserContext } from "playwright";
import { z } from "zod";

const QQ_DRAMA_LIST_API = "https://aishortdrama.qq.com/api/cpplatform/drama/list/v1";
const QQ_CPPLATFORM_URL = "https://aishortdrama.qq.com/cpplatform";
const defaultPageSize = 6;
const maxPages = 100;

const qqUploadedDramaSchema = z.object({
  drama_id: z.coerce.string().min(1),
  title: z.string(),
  approval_status: z.coerce.number().optional(),
  episode_count: z.coerce.number().optional(),
  uploaded_episode_count: z.coerce.number().optional(),
  draft_state: z.coerce.number().optional(),
}).passthrough();

const qqDramaListResponseSchema = z.object({
  dramas: z.array(qqUploadedDramaSchema).default([]),
  total: z.coerce.number().int().nonnegative().default(0),
});

export type QqUploadedDrama = z.infer<typeof qqUploadedDramaSchema>;

function normalizeTitle(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function csrfToken(context: BrowserContext) {
  const cookies = await context.cookies(QQ_CPPLATFORM_URL);
  const token = cookies.find((cookie) => cookie.name === "csrf_token")?.value.trim();
  if (!token) throw new Error("QQ_DRAMA_CSRF_TOKEN_MISSING: 无法读取 QQ 登录态中的 csrf_token");
  return token;
}

export async function findUploadedQqDramaByExactTitle(
  context: BrowserContext,
  title: string,
): Promise<QqUploadedDrama | undefined> {
  const keyword = normalizeTitle(title);
  if (!keyword) throw new Error("QQ_DRAMA_LIST_TITLE_REQUIRED");
  const token = await csrfToken(context);

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await context.request.post(QQ_DRAMA_LIST_API, {
      data: { page, page_size: defaultPageSize, keyword },
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        referer: QQ_CPPLATFORM_URL,
        "x-csrf-token": token,
      },
    });
    if (!response.ok()) {
      const responseText = (await response.text().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      throw new Error(
        `QQ_DRAMA_LIST_QUERY_FAILED: HTTP ${response.status()} ${responseText || "-"}`,
      );
    }

    const payload = qqDramaListResponseSchema.parse(await response.json());
    const exactMatch = payload.dramas.find(
      (drama) => normalizeTitle(drama.title) === keyword,
    );
    if (exactMatch) return exactMatch;
    if (payload.dramas.length < defaultPageSize || page * defaultPageSize >= payload.total) {
      return undefined;
    }
  }

  throw new Error(`QQ_DRAMA_LIST_QUERY_FAILED: 查询页数超过安全上限 ${maxPages}`);
}
