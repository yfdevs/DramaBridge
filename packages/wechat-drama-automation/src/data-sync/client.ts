export interface DarenCenterConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface ApiResponse<T> {
  clientType: string;
  data: T | null;
  message: string;
  service: string;
}

export interface LoginData {
  loginId: string;
  loginType: string;
  tokenName: string;
  tokenValue: string;
}

export interface ImportCopyrightDataOptions {
  signal?: AbortSignal;
  file: Blob;
  filename?: string;
  sourceId: number | string;
}

export interface ImportDramaHeatingActionsOptions {
  signal?: AbortSignal;
  file: Blob;
  filename?: string;
}

export interface ImportDramaHeatingActionsResult {
  batchId?: string;
  receivedCount: number;
  savedCount: number;
}

export interface IngestWeChatDramaStatisticsResult {
  receivedCount: number;
  reportedTotalCount: number;
  savedCount: number;
}

export interface WeChatDramaStatisticsPayload {
  baseResp?: {
    errcode?: number;
    errmsg?: string;
    [key: string]: unknown;
  };
  list: unknown[];
  statisticTime: string;
  totalCount: number;
  wechatVideoAccountName: string;
  [key: string]: unknown;
}

export interface ImportCopyrightDataError {
  columnName: string;
  message: string;
  rowNumber: number;
}

export interface ImportCopyrightDataResult {
  errors: ImportCopyrightDataError[];
  failCount: number;
  successCount: number;
  totalCount: number;
}

export interface DataSource {
  copyrightPartyId: number;
  createdAt: string;
  id: number;
  name: string;
  updatedAt: string;
}

export interface DataSourcePage {
  page: number;
  records: DataSource[];
  size: number;
  total: number;
}

export interface ListDataSourcesOptions {
  signal?: AbortSignal;
  keyword?: string;
  page?: number;
  size?: number;
}

export interface RequestResult<T> {
  body: ApiResponse<T>;
  status: number;
  statusText: string;
}

type QueryValue = boolean | number | string | null | undefined;

export interface DarenCenterRequestOptions<TBody = never> {
  authenticated?: boolean;
  body?: TBody;
  headers?: HeadersInit;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  query?: Record<string, QueryValue | QueryValue[]>;
  signal?: AbortSignal;
}

export interface DarenCenterClientOptions {
  fetch?: typeof fetch;
  onAuthEvent?: (event: {
    status?: number;
    type: "login-started" | "login-succeeded" | "token-refresh";
  }) => void;
}

export class DarenCenterApiError<T = unknown> extends Error {
  readonly response?: ApiResponse<T>;
  readonly status: number;
  readonly statusText: string;

  constructor(result: RequestResult<T>) {
    super(result.body.message || `Daren Center API request failed (${result.status})`);
    this.name = "DarenCenterApiError";
    this.response = result.body;
    this.status = result.status;
    this.statusText = result.statusText;
  }
}

export class DarenCenterDataSourceNotFoundError extends Error {
  readonly sourceName: string;

  constructor(sourceName: string) {
    super(`Daren Center data source not found: ${sourceName}`);
    this.name = "DarenCenterDataSourceNotFoundError";
    this.sourceName = sourceName;
  }
}

export class DarenCenterClient {
  readonly #config: DarenCenterConfig;
  readonly #fetchImplementation: typeof fetch;
  readonly #onAuthEvent?: DarenCenterClientOptions["onAuthEvent"];
  #loginPromise?: Promise<RequestResult<LoginData>>;
  #tokenName = "Authorization";
  #tokenValue?: string;

  constructor(config: DarenCenterConfig, options: DarenCenterClientOptions = {}) {
    this.#config = config;
    this.#fetchImplementation = options.fetch ?? globalThis.fetch;
    this.#onAuthEvent = options.onAuthEvent;
  }

  get authenticated(): boolean {
    return this.#tokenValue !== undefined;
  }

  async login(): Promise<RequestResult<LoginData>> {
    this.#tokenValue = undefined;
    return this.#authenticate();
  }

  async getCurrentUser<T = unknown>(): Promise<RequestResult<T>> {
    return this.request<T>("/api/b/auth/me");
  }

  async listDataSources(
    options: ListDataSourcesOptions = {},
  ): Promise<RequestResult<DataSourcePage>> {
    return this.request<DataSourcePage>("/api/b/data-sources", {
      signal: options.signal,
      query: {
        keyword: options.keyword,
        page: options.page ?? 1,
        size: options.size ?? 20,
      },
    });
  }

  async getSourceId(sourceName: string, signal?: AbortSignal): Promise<number> {
    const normalizedSourceName = sourceName.trim();

    if (!normalizedSourceName) {
      throw new DarenCenterDataSourceNotFoundError(sourceName);
    }

    const pageSize = 100;
    let page = 1;

    while (true) {
      const result = await this.listDataSources({
        signal,
        keyword: normalizedSourceName,
        page,
        size: pageSize,
      });
      const pageData = result.body.data;
      const match = pageData?.records.find((source) => source.name.trim() === normalizedSourceName);

      if (match) {
        return match.id;
      }

      if (!pageData || pageData.records.length === 0 || page * pageData.size >= pageData.total) {
        throw new DarenCenterDataSourceNotFoundError(normalizedSourceName);
      }

      page += 1;
    }
  }

  async importCopyrightData(
    options: ImportCopyrightDataOptions,
  ): Promise<RequestResult<ImportCopyrightDataResult>> {
    const formData = new FormData();
    const filename =
      options.filename ??
      ("name" in options.file && typeof options.file.name === "string"
        ? options.file.name
        : "copyright-data.xls");

    formData.append("files", options.file, filename);
    formData.append("sourceId", String(options.sourceId));

    return this.request<ImportCopyrightDataResult, FormData>("/api/b/copyright-data/import", {
      signal: options.signal,
      body: formData,
      method: "POST",
    });
  }

  async importDramaHeatingActions(
    options: ImportDramaHeatingActionsOptions,
  ): Promise<RequestResult<ImportDramaHeatingActionsResult>> {
    const formData = new FormData();
    // The backend validates the multipart filename. Local archive names include
    // the account and date and can exceed its limit; keep the upload name short.
    formData.append("file", options.file, "data.csv");

    return this.request<ImportDramaHeatingActionsResult, FormData>(
      "/api/b/drama-heating/actions/import",
      {
        signal: options.signal,
        body: formData,
        method: "POST",
      },
    );
  }

  async ingestWeChatDramaStatistics(
    statistics: WeChatDramaStatisticsPayload,
    signal?: AbortSignal,
  ): Promise<RequestResult<IngestWeChatDramaStatisticsResult>> {
    return this.request<IngestWeChatDramaStatisticsResult, WeChatDramaStatisticsPayload>(
      "/api/b/wechat-drama/statistics/ingest",
      {
        authenticated: false,
        signal,
        body: statistics,
        method: "POST",
      },
    );
  }

  /**
   * Common API entry point. It serializes JSON, injects the token, parses the
   * standard response envelope and refreshes authentication once after a 401.
   * FormData bodies are forwarded untouched so fetch can generate the multipart
   * boundary.
   */
  async request<TResponse, TBody = never>(
    path: string,
    options: DarenCenterRequestOptions<TBody> = {},
  ): Promise<RequestResult<TResponse>> {
    return this.#request(path, options, true);
  }

  clearToken(): void {
    this.#tokenValue = undefined;
  }

  async #request<TResponse, TBody>(
    path: string,
    options: DarenCenterRequestOptions<TBody>,
    retryUnauthorized: boolean,
  ): Promise<RequestResult<TResponse>> {
    const authenticated = options.authenticated ?? true;
    let requestToken: string | undefined;

    if (authenticated) {
      requestToken = await waitWithSignal(this.#getToken(), options.signal);
    }

    const result = await this.#fetch<TResponse, TBody>(path, options, requestToken);

    if (result.status === 401 && authenticated && retryUnauthorized) {
      this.#onAuthEvent?.({ status: result.status, type: "token-refresh" });
      // Another concurrent request may already have refreshed the token.
      if (this.#tokenValue === requestToken) {
        this.#tokenValue = undefined;
      }

      await waitWithSignal(this.#getToken(), options.signal);
      return this.#request(path, options, false);
    }

    if (!isSuccessful(result.status)) {
      throw new DarenCenterApiError(result);
    }

    if (options.method === "POST" && result.body.data == null) {
      throw new Error("后台未返回导入结果，无法确认是否写入；请核对后台记录后再重试");
    }

    return result;
  }

  async #authenticate(): Promise<RequestResult<LoginData>> {
    if (this.#loginPromise) {
      return this.#loginPromise;
    }

    this.#loginPromise = this.#performLogin();

    try {
      return await this.#loginPromise;
    } finally {
      this.#loginPromise = undefined;
    }
  }

  async #performLogin(): Promise<RequestResult<LoginData>> {
    this.#onAuthEvent?.({ type: "login-started" });
    const result = await this.#fetch<LoginData, { password: string; username: string }>(
      "/api/b/auth/login",
      {
        authenticated: false,
        body: {
          password: this.#config.password,
          username: this.#config.username,
        },
        method: "POST",
      },
      undefined,
    );

    if (!isSuccessful(result.status)) {
      throw new DarenCenterApiError(result);
    }

    const loginData = result.body.data;

    if (!loginData?.tokenValue) {
      throw new DarenCenterApiError({
        ...result,
        body: {
          ...result.body,
          message: result.body.message || "Login response does not contain a token",
        },
      });
    }

    this.#tokenName = loginData.tokenName || "Authorization";
    this.#tokenValue = loginData.tokenValue;
    this.#onAuthEvent?.({ status: result.status, type: "login-succeeded" });

    return result;
  }

  async #fetch<TResponse, TBody>(
    path: string,
    options: DarenCenterRequestOptions<TBody>,
    tokenValue: string | undefined,
  ): Promise<RequestResult<TResponse>> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json, text/plain, */*");
    headers.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("cache-control", "no-cache");
    headers.set("pragma", "no-cache");

    const requestBody = serializeRequestBody(options.body);

    if (
      requestBody !== undefined &&
      !(requestBody instanceof FormData) &&
      !headers.has("content-type")
    ) {
      headers.set("content-type", "application/json;charset=UTF-8");
    }

    if (tokenValue) {
      headers.set(this.#tokenName, tokenValue);
    }

    const response = await this.#fetchImplementation(this.#createUrl(path, options.query), {
      body: requestBody,
      headers,
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(this.#config.timeoutMs)])
        : AbortSignal.timeout(this.#config.timeoutMs),
    });
    const body = await parseResponse<TResponse>(response);

    return {
      body,
      status: response.status,
      statusText: response.statusText,
    };
  }

  #createUrl(path: string, query: DarenCenterRequestOptions<unknown>["query"]): URL {
    const url = new URL(path, `${this.#config.baseUrl}/`);

    for (const [name, rawValue] of Object.entries(query ?? {})) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];

      for (const value of values) {
        if (value !== undefined && value !== null) {
          url.searchParams.append(name, String(value));
        }
      }
    }

    return url;
  }

  async #getToken(): Promise<string> {
    if (this.#tokenValue) {
      return this.#tokenValue;
    }

    const result = await this.#authenticate();
    return result.body.data!.tokenValue;
  }
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function serializeRequestBody<T>(body: T | undefined): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (body instanceof FormData) {
    return body;
  }

  return JSON.stringify(body);
}

async function parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();

  if (!text) {
    if (response.ok) throw new Error("后台返回空响应，无法确认导入结果；请核对后台记录后再重试");
    return {
      clientType: "",
      data: null,
      message: response.statusText,
      service: "",
    };
  }

  try {
    const body = JSON.parse(text) as ApiResponse<T>;
    if (response.ok && (!body || typeof body !== "object" || !("data" in body))) {
      throw new Error("invalid response envelope");
    }
    return body;
  } catch {
    if (response.ok) throw new Error("后台响应格式异常，无法确认导入结果；请核对后台记录后再重试");
    return {
      clientType: "",
      data: null,
      message: text,
      service: "",
    };
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Operation aborted"));
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
