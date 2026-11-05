export type FeishuCredentials = { appId: string; appSecret: string };
export class FeishuApiError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(`飞书请求失败 (${code})：${message}`);
  }
}

/** Server/main-process only. Never expose credentials or tokens to renderer code. */
export class FeishuClient {
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  constructor(
    private credentials: FeishuCredentials,
    private transport: typeof fetch = fetch,
  ) {}

  private async json(url: string, init: RequestInit) {
    const response = await this.transport(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok || (typeof body.code === "number" && body.code !== 0) || body.error) {
      throw new FeishuApiError(
        Number(body.code || response.status),
        String(body.msg || body.error_description || response.statusText),
      );
    }
    return body;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const body = await this.json("https://accounts.feishu.cn/oauth/v3/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.credentials.appId,
          client_secret: this.credentials.appSecret,
        }),
      });
      if (typeof body.access_token !== "string" || !(Number(body.expires_in) > 0))
        throw new Error("飞书未返回有效访问凭证");
      this.token = {
        value: body.access_token,
        expiresAt: Date.now() + Number(body.expires_in) * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  async request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("无效飞书 API 路径");
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      try {
        const result = await this.json(`https://open.feishu.cn/open-apis${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return result.data as T;
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof FeishuApiError &&
          [99991661, 99991663, 99991668].includes(error.code)
        ) {
          this.token = undefined;
          continue;
        }
        throw error;
      }
    }
  }
}
