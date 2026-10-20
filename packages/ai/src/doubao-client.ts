import { OpenAiCompatibleClient } from "./openai-compatible-client.js";
import type { OpenAiCompatibleClientOptions } from "./types.js";

export const DEFAULT_DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export type DoubaoClientOptions = OpenAiCompatibleClientOptions;

export class DoubaoAiClient extends OpenAiCompatibleClient {
  constructor(options: DoubaoClientOptions) {
    super({
      ...options,
      baseURL: options.baseURL ?? DEFAULT_DOUBAO_BASE_URL,
    });
  }
}

export function createDoubaoAiClient(options: DoubaoClientOptions): DoubaoAiClient {
  return new DoubaoAiClient(options);
}
