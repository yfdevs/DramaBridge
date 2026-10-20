export type AiImageDetail = "auto" | "low" | "high";

export type AiImageInput =
  | {
      type: "url";
      url: string;
      detail?: AiImageDetail;
    }
  | {
      type: "file";
      path: string;
      mimeType?: string;
      detail?: AiImageDetail;
    }
  | {
      type: "data-url";
      dataUrl: string;
      detail?: AiImageDetail;
    };

export interface OpenAiCompatibleClientOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export type DoubaoClientOptions = OpenAiCompatibleClientOptions;

export interface AiGenerationOptions {
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TextGenerationOptions extends AiGenerationOptions {
  prompt: string;
}

export interface ImageAnalysisOptions extends AiGenerationOptions {
  images: readonly AiImageInput[];
  prompt: string;
}

export interface ImageGenerationOptions {
  prompt: string;
  referenceImages?: readonly AiImageInput[];
  model?: string;
  size?: string;
  watermark?: boolean;
}

export interface AiGeneratedImage {
  data: Uint8Array;
  mimeType: string;
  revisedPrompt?: string;
}

export interface AiImageGenerationResult {
  images: AiGeneratedImage[];
  model: string;
  requestId?: string;
}

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiCompletionResult {
  finishReason: string | null;
  model: string;
  requestId?: string;
  text: string;
  usage?: AiTokenUsage;
}

export interface AiJsonCompletionResult extends AiCompletionResult {
  data: Record<string, unknown>;
}

export interface DramaAiClient {
  analyzeImages(options: ImageAnalysisOptions): Promise<AiCompletionResult>;
  generateImage(options: ImageGenerationOptions): Promise<AiImageGenerationResult>;
  generateText(options: TextGenerationOptions): Promise<AiCompletionResult>;
}
