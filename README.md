# DramaBridge

Multi-platform desktop automation app built with Electron, React, TypeScript, and Vite+.

macOS 适配范围、实施顺序和验收标准见 [macOS 适配修复方案](MACOS_ADAPTATION_PLAN.md)。

## Scripts

Pushes to `master` run **Build and release desktop** in GitHub Actions. It selects
the next patch version above `package.json` and existing stable `v*` tags, checks
types, builds the Windows x64 NSIS installer and Apple Silicon Mac DMG/ZIP, then commits the version and tag back to
`master`. The bot commit does not trigger another release. Each release includes
the Windows installer, its `.blockmap`, `latest.yml` for the Windows updater, and the Mac arm64 DMG/ZIP. Files
are uploaded to a draft before the release becomes public, and retained as an
Actions artifact for 14 days. You can also start it from Actions → Build and
release desktop → Run workflow on `master`.

The workflow uses the built-in `GITHUB_TOKEN`; no personal token is needed. The
repository must allow Actions to write contents and push to `master` (branch
protection rules may otherwise reject the version commit). Concurrent releases
are serialized. If another push advances `master` during a build, the version
push fails safely without overwriting that commit; the next queued run builds
the latest branch. After a bot version commit, run `git pull` before pushing your
next local change. Local `pnpm release:win` remains available.

- `pnpm dev` starts the Vite+ dev server and Electron.
- `pnpm build:app` builds workspace packages, checks types, verifies the shared Playwright browser, and builds the renderer and Electron with Vite+ task caching.
- `pnpm build` runs `build:app` and packages Electron. Installer packaging and its runtime checks run each time.
- `pnpm build:mac` builds and packages the Apple Silicon version on an M-series Mac using arm64 Node.js.
- `pnpm build:mac --dir` produces the unpacked Mac app for local verification.
- `pnpm package:mac` packages existing `dist` and `dist-electron` outputs for arm64 without rebuilding the application.
- `pnpm lint` runs Vite+ linting through Oxlint.
- `vp check --no-fmt` runs Vite+ linting and type checks without rewriting existing formatting.

## Mac builds

Mac packages support **Apple Silicon (M-series) only**. Intel, Rosetta/x64 Node.js,
universal packages and cross-platform Mac packaging are rejected before staging
native dependencies. Use an arm64 Node.js installation and run `pnpm install`
before `pnpm build:mac`.

The output directory is `release/<version>/`:

- `DramaBridge-Mac-<version>-arm64.dmg`
- `DramaBridge-Mac-<version>-arm64.zip`
- `mac-arm64/DramaBridge.app`

The build bundles the matching Apple Silicon Playwright browser and verifies
SQLite, Sharp, canvas, atomic writes and FFmpeg inside the packaged app.
The Mac build does not enable the Windows-only in-app updater.

**Build macOS Apple Silicon** can also run independently from Actions → Run
workflow. It builds the selected commit at its existing package version and
retains DMG/ZIP artifacts for 14 days; it does not commit, tag or publish.

For automatic desktop releases, the Windows job prepares the version and shares
its exact source commit and package manifest with the reusable Mac workflow.
Mac runs natively on `macos-15` (arm64). The final release job commits/tags and
publishes only after both platforms succeed, so there is only one version bump
and one complete GitHub Release. A failed Mac build leaves the version unpushed
and preserves the completed Windows artifact for inspection.

Default Mac builds use an ad-hoc signature and do not require Apple secrets.
They are not Developer ID signed or notarized. Public distribution that passes
Gatekeeper verification requires an Apple Developer ID certificate and Apple
notarization configured for the release; see the
[electron-builder 26 signing documentation](https://www.electron.build/v26/docs/mac/).

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
