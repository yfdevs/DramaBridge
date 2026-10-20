import type {
  AiJsonCompletionResult,
  DramaAiClient,
  ImageAnalysisOptions,
} from "./types.js";

function stripMarkdownFence(text: string) {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Parses a JSON object from an AI response. A single Markdown JSON fence and
 * short provider-added text surrounding the object are tolerated, while
 * arrays and primitive values remain invalid for predictable callers.
 */
export function parseAiJsonObject(text: string): Record<string, unknown> {
  const normalized = stripMarkdownFence(text);
  const candidates = [normalized];
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const objectText = normalized.slice(objectStart, objectEnd + 1);
    if (objectText !== normalized) candidates.push(objectText);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("DRAMA_AI_JSON_OBJECT_REQUIRED");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      lastError = error;
    }
  }

  throw Object.assign(new Error("DRAMA_AI_JSON_RESPONSE_INVALID"), {
    cause: lastError,
  });
}

export async function analyzeImagesAsJson(
  client: DramaAiClient,
  options: ImageAnalysisOptions,
): Promise<AiJsonCompletionResult> {
  const result = await client.analyzeImages(options);
  return {
    ...result,
    data: parseAiJsonObject(result.text),
  };
}
