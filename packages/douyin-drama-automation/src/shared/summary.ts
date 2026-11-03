import { optimizeTextLength, type DramaAiClient } from "@dramabridge/ai";
import { sanitizeDouyinDescriptionText } from "../automation/form-controls.js";

export async function optimizeDouyinSummary(text: string, client?: { generateText: (options: Parameters<DramaAiClient["generateText"]>[0]) => Promise<{ text: string }> }) {
  const clean = (value: string) => sanitizeDouyinDescriptionText(value, Number.MAX_SAFE_INTEGER);
  const source = clean(text);
  if (source.length >= 101 && source.length <= 200) return source;
  if (!client) throw new Error("DOUYIN_DRAMA_AI_CLIENT_REQUIRED: 简介需 AI 优化到101-200字符，请配置全局 AI");
  return optimizeTextLength({
    client: {
      generateText: async (options) => {
        const result = await client.generateText(options);
        return { ...result, text: clean(result.text) };
      },
    },
    text: source,
    minLength: 101,
    maxLength: 200,
    fieldName: "抖音短剧剧情简介",
    instructions: "最终101-200字符（含标点），忠于原文，过长自然压缩、过短自然扩写；只输出简介，不输出字数说明。",
  });
}
