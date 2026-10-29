import { z } from "zod";
import type { TaobaoDramaAccount } from "../shared/types.js";

const accountSchema = z.object({
  id: z.coerce.number().int(), accountId: z.string().trim().min(1),
  accountName: z.string().trim().nullish(), loginAccount: z.string().nullish(),
  rpaProfileKey: z.string().nullish(), sortNo: z.coerce.number().optional(), status: z.string(),
});
const responseSchema = z.object({
  code: z.number(), msg: z.string().nullish(),
  data: z.object({ total: z.coerce.number().int().nonnegative().optional(), data: z.array(accountSchema) }).nullish(),
});

export async function fetchTaobaoDramaAccounts(
  apiBaseUrl: string,
  fetcher: typeof fetch = fetch,
  options: { includeDisabled?: boolean } = {},
): Promise<TaobaoDramaAccount[]> {
  const baseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("TAOBAO_DRAMA_API_BASE_URL_REQUIRED");
  const accounts: z.infer<typeof accountSchema>[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetcher(`${baseUrl}/dramaAiRpa/taobao/accountConfig/page`, {
      method: "POST",
      headers: { accept: "application/json, text/plain, */*", "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ page, pageSize: 100, accountId: null, accountName: null, status: options.includeDisabled ? null : "ON" }),
    });
    if (!response.ok) throw new Error(`TAOBAO_DRAMA_ACCOUNT_CONFIG_REQUEST_FAILED: status=${response.status}`);
    const payload = responseSchema.parse(await response.json());
    if (payload.code !== 0) throw new Error(`TAOBAO_DRAMA_ACCOUNT_CONFIG_REQUEST_FAILED: code=${payload.code} message=${payload.msg || "-"}`);
    if (!payload.data) throw new Error("TAOBAO_DRAMA_ACCOUNT_CONFIG_RESPONSE_DATA_REQUIRED");
    accounts.push(...payload.data.data);
    if (payload.data.data.length < 100 || (payload.data.total !== undefined && accounts.length >= payload.data.total)) break;
  }
  const unique = new Map<string, TaobaoDramaAccount>();
  for (const account of accounts.filter((item) => options.includeDisabled || item.status === "ON").sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0))) {
    unique.set(account.accountId, {
      id: account.id, accountId: account.accountId, accountName: account.accountName || account.accountId,
      loginAccount: account.loginAccount, rpaProfileKey: account.rpaProfileKey, status: account.status,
    });
  }
  return [...unique.values()];
}
