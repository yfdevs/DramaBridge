import OpenAI, { toFile } from "openai";
import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import { resolveImageDataUrl } from "./image-input.js";
import type {
  AiCompletionResult,
  AiGenerationOptions,
  DramaAiClient,
  ImageAnalysisOptions,
  ImageGenerationOptions,
  AiImageGenerationResult,
  OpenAiCompatibleClientOptions,
  TextGenerationOptions,
} from "./types.js";

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";

function requiredValue(value: string, errorCode: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

function validateGenerationOptions(options: AiGenerationOptions): void {
  if (options.maxTokens !== undefined && options.maxTokens <= 0) {
    throw new Error("DRAMA_AI_MAX_TOKENS_INVALID");
  }
  if (
    options.temperature !== undefined &&
    (options.temperature < 0 || options.temperature > 2)
  ) {
    throw new Error("DRAMA_AI_TEMPERATURE_INVALID");
  }
}

function completionResult(completion: ChatCompletion, requestId?: string): AiCompletionResult {
  const choice = completion.choices[0];
  if (!choice) throw new Error("DRAMA_AI_RESPONSE_CHOICE_MISSING");

  const text = choice.message.content?.trim();
  if (!text) throw new Error("DRAMA_AI_RESPONSE_TEXT_MISSING");

  return {
    finishReason: choice.finish_reason,
    model: completion.model,
    requestId,
    text,
    usage: completion.usage
      ? {
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        }
      : undefined,
  };
}

export class OpenAiCompatibleClient implements DramaAiClient {
  readonly baseURL: string;
  readonly model: string;
  private readonly sdk: OpenAI;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleClientOptions) {
    const apiKey = requiredValue(options.apiKey, "DRAMA_AI_API_KEY_REQUIRED");
    this.apiKey = apiKey;
    this.model = requiredValue(options.model, "DRAMA_AI_MODEL_REQUIRED");
    this.baseURL = requiredValue(
      options.baseURL ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      "DRAMA_AI_BASE_URL_REQUIRED",
    ).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;

    this.sdk = new OpenAI({
      apiKey,
      baseURL: this.baseURL,
      maxRetries: options.maxRetries ?? 2,
      timeout: this.timeoutMs,
    });
  }

  async generateText(options: TextGenerationOptions): Promise<AiCompletionResult> {
    validateGenerationOptions(options);
    const prompt = requiredValue(options.prompt, "DRAMA_AI_PROMPT_REQUIRED");
    const messages: ChatCompletionMessageParam[] = [];
    const systemPrompt = options.systemPrompt?.trim();
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const { data: completion, request_id: requestId } =
      await this.sdk.chat.completions
        .create({
          model: options.model?.trim() || this.model,
          messages,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
        })
        .withResponse();
    return completionResult(completion, requestId ?? undefined);
  }

  async analyzeImages(options: ImageAnalysisOptions): Promise<AiCompletionResult> {
    validateGenerationOptions(options);
    const prompt = requiredValue(options.prompt, "DRAMA_AI_PROMPT_REQUIRED");
    if (options.images.length === 0) throw new Error("DRAMA_AI_IMAGE_REQUIRED");

    const resolvedImages = await Promise.all(
      options.images.map(async (image): Promise<ChatCompletionContentPart> => ({
        type: "image_url",
        image_url: {
          url: await resolveImageDataUrl(image),
          ...(image.detail ? { detail: image.detail } : {}),
        },
      })),
    );
    const content: ChatCompletionContentPart[] = [
      { type: "text", text: prompt },
      ...resolvedImages,
    ];
    const messages: ChatCompletionMessageParam[] = [];
    const systemPrompt = options.systemPrompt?.trim();
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content });

    const { data: completion, request_id: requestId } =
      await this.sdk.chat.completions
        .create({
          model: options.model?.trim() || this.model,
          messages,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
        })
        .withResponse();
    return completionResult(completion, requestId ?? undefined);
  }

  async generateImage(options: ImageGenerationOptions): Promise<AiImageGenerationResult> {
    const prompt = requiredValue(options.prompt, "DRAMA_AI_PROMPT_REQUIRED");
    const model = options.model?.trim() || this.model;
    const referenceImages = await Promise.all(
      (options.referenceImages ?? []).map((image) => resolveImageDataUrl(image)),
    );

    const providerResponse = await fetch(`${this.baseURL}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        ...(referenceImages.length === 1
          ? { image: referenceImages[0] }
          : referenceImages.length > 1
            ? { image: referenceImages }
            : {}),
        size: options.size ?? "2K",
        sequential_image_generation: "disabled",
        stream: false,
        response_format: "url",
        watermark: options.watermark ?? false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (providerResponse.ok) {
      const payload = await providerResponse.json() as {
        model?: string;
        data?: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>;
      };
      return {
        images: await resolveGeneratedImages(payload.data ?? []),
        model: payload.model?.trim() || model,
        requestId: providerResponse.headers.get("x-request-id") ?? undefined,
      };
    }

    const providerError = await providerResponse.text().catch(() => "");
    try {
      const fallbackSize = openAiLandscapeSize(options.size);
      if (referenceImages.length > 0) {
        const uploads = await Promise.all(
          referenceImages.map((dataUrl, index) => {
            const parsed = parseDataUrl(dataUrl);
            return toFile(parsed.data, `reference-${index + 1}.${extensionForMime(parsed.mimeType)}`, {
              type: parsed.mimeType,
            });
          }),
        );
        const { data: result, request_id: requestId } = await this.sdk.images.edit({
          image: uploads,
          model,
          prompt,
          response_format: "b64_json",
          size: fallbackSize,
          stream: false,
        }).withResponse();
        return {
          images: await resolveGeneratedImages(result.data ?? []),
          model,
          requestId: requestId ?? undefined,
        };
      }

      const { data: result, request_id: requestId } = await this.sdk.images.generate({
        model,
        prompt,
        response_format: "b64_json",
        size: fallbackSize,
        stream: false,
      }).withResponse();
      return {
        images: await resolveGeneratedImages(result.data ?? []),
        model,
        requestId: requestId ?? undefined,
      };
    } catch (fallbackError) {
      throw Object.assign(
        new Error(
          `DRAMA_AI_IMAGE_GENERATION_FAILED: HTTP ${providerResponse.status}; ${providerError.slice(0, 500)}`,
        ),
        { cause: fallbackError },
      );
    }
  }
}

function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!match) throw new Error("DRAMA_AI_IMAGE_DATA_URL_INVALID");
  return {
    data: Buffer.from(match[2], "base64"),
    mimeType: match[1].toLowerCase(),
  };
}

function extensionForMime(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function openAiLandscapeSize(size: string | undefined): "1536x1024" | "1024x1024" | "1024x1536" {
  if (size === "1024x1024" || size === "1024x1536" || size === "1536x1024") return size;
  return "1536x1024";
}

async function resolveGeneratedImages(
  images: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>,
) {
  if (images.length === 0) throw new Error("DRAMA_AI_IMAGE_RESPONSE_MISSING");

  return Promise.all(images.map(async (image) => {
    if (image.b64_json) {
      return {
        data: Buffer.from(image.b64_json, "base64"),
        mimeType: "image/png",
        revisedPrompt: image.revised_prompt,
      };
    }
    if (image.url) {
      const response = await fetch(image.url);
      if (!response.ok) {
        throw new Error(`DRAMA_AI_IMAGE_DOWNLOAD_FAILED: HTTP ${response.status}`);
      }
      return {
        data: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type")?.split(";")[0] || "image/png",
        revisedPrompt: image.revised_prompt,
      };
    }
    throw new Error("DRAMA_AI_IMAGE_RESPONSE_MISSING");
  }));
}

export function createOpenAiCompatibleClient(
  options: OpenAiCompatibleClientOptions,
): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient(options);
}
