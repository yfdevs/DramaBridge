# @dramabridge/ai

平台无关的 AI 能力包。通过 OpenAI Node SDK 连接任意 OpenAI 兼容模型服务，为各平台自动化复用文本生成、封面识别等能力。

```ts
import { createOpenAiCompatibleClient } from "@dramabridge/ai";

const ai = createOpenAiCompatibleClient({
  apiKey: projectConfig.aiApiKey,
  baseURL: projectConfig.aiBaseURL,
  model: projectConfig.aiModel,
});

const result = await ai.analyzeImages({
  images: [{ type: "file", path: coverPath }],
  prompt: "识别封面中的剧名",
});
```

`apiKey`、`baseURL` 和 `model` 均由应用主进程从项目配置注入，不从环境变量读取。分析图片时，应使用服务商提供的、支持视觉输入的模型。

AI 单次请求默认最多等待 5 分钟（`DEFAULT_AI_REQUEST_TIMEOUT_MS = 300_000`），统一用于文本生成、图片识别及图片生成，包括图片生成的兼容回退请求。各平台通过全局配置创建的客户端共用此设置。需要单独限制的调用方仍可显式传入 `timeoutMs`；SDK 和业务层重试次数保持各自原有设置。

为了兼容既有调用，包内仍保留 `createDoubaoAiClient` 和豆包默认地址；新代码优先使用通用的 `createOpenAiCompatibleClient`。

平台字段有长度限制时，统一使用 `optimizeTextLength`。合规文本会原样返回且不调用模型；超限文本会经过 AI 精炼、重试和最终安全长度兜底：

```ts
import { optimizeTextLength } from "@dramabridge/ai";

const summary = await optimizeTextLength({
  client: ai,
  text: originalSummary,
  maxLength: 200,
  fieldName: "作品简介",
  contentDescription: "平台上剧页展示的剧情简介",
});
```
