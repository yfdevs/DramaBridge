# DramaBridge

Multi-platform desktop automation app built with Electron, React, TypeScript, and Vite+.

macOS 适配范围、实施顺序和验收标准见 [macOS 适配修复方案](MACOS_ADAPTATION_PLAN.md)。

## Scripts

- `pnpm dev` starts the Vite+ dev server and Electron.
- `pnpm build:app` builds workspace packages, checks types, verifies the shared Playwright browser, and builds the renderer and Electron with Vite+ task caching.
- `pnpm build` runs `build:app` and packages Electron. Installer packaging and its runtime checks run each time.
- `pnpm lint` runs Vite+ linting through Oxlint.
- `vp check --no-fmt` runs Vite+ linting and type checks without rewriting existing formatting.

## Build cache

Use `pnpm build:app` for routine builds. Vite+ stores task results in `node_modules/.vite/task-cache` and restores unchanged packages, `dist`, and `dist-electron` on a cache hit. Direct `pnpm exec vp build` and package `build` scripts bypass the configured task cache.

Package cache inputs include each package's sources, build configuration, and transitive workspace dependencies. Changes under a package's `tests` directory do not invalidate its build task. App inputs also include renderer assets, public files, Electron sources, environment files, and Vite configuration. The build entry still clears app outputs before restoring or building them, so old hashed chunks cannot leak into a packaged app. Playwright installation is checked on every run and skips downloading when the expected browser is already present.

- Build only Taobao and its configured dependencies: `pnpm exec vp run pkg:taobao:build`.
- Inspect the last run's cache hits and misses: `pnpm exec vp run --last-details`.
- Rebuild without task caching: `pnpm exec vp run --no-cache app:build`.
- Remove all task cache entries: `pnpm exec vp cache clean`.

## 通用任务材料字段约定

任务接口的 `payloadJson` 使用以下字段传递制作、版权、成本和 AI 证明材料。不同平台可能把这些字段直接放在 `payloadJson`，或放在 `payloadJson.playlet` 等平台数据对象中；具体层级以对应平台 README 为准。

| 字段                             | 材料含义                  | 说明                                                                                                              |
| -------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `copyright.productionProofFiles` | 制作合同 / 制作证明材料   | 用于证明剧目制作关系或制作主体，通常上传短剧制作合同。部分平台页面显示为“知识产权声明文件”或“剧目制作证明材料”。  |
| `copyright.licenseProofFiles`    | 版权证明 / 授权材料       | 用于证明版权归属、采购或播出授权，例如版权证明、版权采买合同、授权委托书或播出授权书。                            |
| `productionCost.proofFiles`      | 制作成本证明材料          | 用于证明剧目制作成本，通常上传成本配置比例情况报告、成本明细或其他成本佐证文件；该字段不是“制作成本合同”。        |
| `aiContent`                      | 是否开启 AI 内容声明      | 布尔值。微信小程序平台正在使用该字段；缺失时默认 `true`，只有明确传 `false` 才关闭 AI 声明并跳过 AI 证明上传。    |
| `aiProductionProofFiles`         | AI 制作证明 / AI 声明文件 | 微信小程序平台正在使用的文件数组。`aiContent` 开启时用于上传 AI 制作证明，支持平台允许的本地路径或 HTTP(S) 地址。 |

材料文件字段统一使用文件引用数组；文件引用可以是平台支持的本地路径或 HTTP(S) 下载地址。例如：

```json
{
  "copyright": {
    "productionProofFiles": ["https://example.com/production-contract.pdf"],
    "licenseProofFiles": ["https://example.com/copyright-authorization.pdf"]
  },
  "productionCost": {
    "proofFiles": ["https://example.com/production-cost-report.pdf"]
  },
  "aiContent": true,
  "aiProductionProofFiles": ["https://example.com/ai-production-proof.pdf"]
}
```
