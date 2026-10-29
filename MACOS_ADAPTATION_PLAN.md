# DramaBridge macOS 适配修复方案

日期：2026 年 10 月 29 日  
代码基线：0.2.23  
状态：待审阅，尚未实施

目标是在保持现有 Windows 功能正常的前提下，让 DramaBridge 在搭载 Apple Silicon M 系列芯片的 Mac 上完成账号选择、浏览器登录、素材处理和平台发布。macOS 端仅适配 arm64，不适配 Intel x64，不构建 Universal 通用包。现有 React 页面、平台 IPC、任务领取及结果上报逻辑继续复用，系统差异集中在路径、浏览器、原生依赖和客户端启动边界。

建议先交付 M 系列 Mac arm64 的本地素材发布版，再接入百度网盘完整自动下载。百度网盘是完整流程的关键依赖，必须先在 M 系列 Mac 验证客户端能力；不能通过删除 Windows 限制来宣称完成适配。

## 一 交付范围

| 阶段 | 交付内容 | 完成条件 |
| --- | --- | --- |
| 首版本地素材发布 | Mac arm64 安装包，账号选择与登录，本地素材校验，转码与图片处理，平台发布和结果上报 | 淘宝、抖音各完成一条经授权的真实任务；其他平台按各自用例逐项验收 |
| 网盘全流程 | 从百度分享链接准备素材，再接入原有发布流程 | 下载、暂停恢复、重试、文件完整性校验和发布衔接通过 Mac 验收 |
| 正式分发 | 签名、公证、安装包下载和自动更新 | 干净 Mac 可安装启动；旧版本可更新到新版本并保留数据 |
| 后续功能扩展 | M 系列 Mac 的可选本机 OCR | 单独验收，不计入首版完成条件 |

架构范围已确定为 Apple Silicon M 系列的 arm64，所有阶段均不包含其他 Mac 架构，也不安排 Intel x64 后续适配。最低支持的 macOS 版本应在核对当前 Electron、Playwright 和原生依赖要求后确定，并纳入 M 系列 Mac 实机测试矩阵。

## 二 现有问题和修改位置

| 编号 | 当前问题 | 主要修改位置 | 修复方向 |
| --- | --- | --- | --- |
| M01 | 非 Windows 的 Chromium 安装检测按 Linux 路径处理 | `scripts/install-playwright-browsers.mjs` | 补充 macOS 浏览器定位，匹配 Playwright 实际版本与目标架构，验证可执行文件存在且可启动 |
| M02 | 打包依赖在未传入 arm64 时默认按 x64 安装，部分产物检查仅覆盖 Windows | `scripts/package-electron-hoisted.mjs`、`electron-builder.json5` | Mac 构建固定为 arm64，拒绝其他 Mac 架构目标；隔离暂存及二进制缓存；补 Mac 安装包内的运行检查；文件名包含 arm64 |
| M03 | 默认目录、磁盘监控和清理存在 D 盘假设 | `electron/platforms/shared/index.ts`、`electron/global-app-config.ts`、`electron/app-runtime.ts`、`electron/platforms/baidu-netdisk/index.ts`、各平台配置页 | 改为用户可写目录及实际素材目录所在卷；界面动态显示磁盘；保留严格的清理范围限制 |
| M04 | 淘宝、拼多多默认 Chrome 路径只搜索 Windows 安装位置 | `electron/platforms/taobao-drama/index.ts`、`electron/platforms/pinduoduo-drama/index.ts` | 补充 Mac 应用包内可执行路径；保留用户指定路径及现有 Chrome channel 回退；错误提示适配系统 |
| M05 | 粘贴和全选存在固定 Control 快捷键 | `packages/taobao-drama-automation/src/automation/tag-clipboard.ts`、`episodes.ts`，以及其他平台命中的表单操作 | 全选、粘贴使用跨平台修饰键；文档末尾等导航快捷键单独验证；回归剪贴板保存及恢复 |
| M06 | 网盘客户端启动和下载明确限制为 Windows | `packages/baidu-netdisk-automation/src/runtime/baidu-netdisk-runtime.ts`、`src/workflows/download-baidu-folder.ts`、`electron/platforms/baidu-netdisk/` | 先验证 Mac 客户端是否支持所需 CDP；再实现系统启动适配和下载流程；网页连接逻辑按能力复用 |
| M07 | 发布文件清单和更新器只覆盖 Windows | `scripts/release-win.mjs`、`scripts/release-version.mjs`、`scripts/publish-github-release.mjs`、`electron/app-updater.ts` | 增加 Mac 发布入口，按系统和架构选择安装包及更新元数据，共享同一发布版本 |
| M08 | 应用清空原生菜单，自定义标题栏需要 Mac 实测 | `electron/main.ts`、`electron/core/main-window.ts`、`electron/preload.ts`、标题栏组件 | 添加 Mac 应用及编辑菜单；验证 Command 快捷键、窗口控制、Dock 恢复和退出时服务清理 |
| M09 | 本机 OCR 依赖 Windows | `electron/local-ownership-ocr.ts` | 首版沿用已有 AI 识别回退，本机 OCR 独立评估 |
| M10 | 多处浏览器测试写死 Windows Chromium 路径 | 各平台 `tests/automation/`、`tests/electron/` | 统一测试浏览器定位；增加 macOS 测试环境，保留 Windows 回归 |

## 三 实施顺序

### 第一步 验证 Mac 网盘能力

在真实 M 系列 Mac 上记录芯片型号、系统版本、arm64 运行架构、百度网盘客户端版本和安装位置，验证以下能力：

1. 能否正常启动客户端并连接调试端口，客户端重启后能否恢复连接。
2. 能否识别登录状态、访问分享链接、转存并下载指定文件。
3. 能否指定下载目录、判断单文件完成和整部剧完整性。
4. 能否保留现有失败重试、取消、暂停恢复和去重语义。

产出一份能力验证记录和可重复的操作步骤。若客户端不提供所需能力，记录具体阻碍，本地素材版继续推进，网盘全流程保持未完成状态；替代下载方案另行评估。

### 第二步 修复系统基础层

- 统一操作系统、CPU 架构、浏览器和媒体工具的定位，工具脚本与 Electron 启动边界分别接入，避免引入跨层依赖。
- 保留现有全局目录配置入口。未配置时可提供用户目录建议，但继续执行必要的目录可写性、素材完整性校验。
- 浏览器账号目录、SQLite、配置及日志不得写入安装包目录。修正主日志在异常回退时使用 Windows AppData 路径的问题。
- 磁盘监控使用运行数据或素材目录所在卷；磁盘清理只允许作用于明确配置的素材根目录，并排除卷根、用户主目录和符号链接越界。
- 检查路径拼接、大小写比较和中文文件名。不要在所有系统上无条件转小写作为文件身份。
- 淘宝、拼多多补充 Mac Chrome 定位。配置界面说明选择应用包还是实际可执行文件，并由主进程统一解析和验证。

验收：应用能启动；目录配置可保存；账号列表可加载；仅启动所选账号；重启后配置仍有效；停止服务后浏览器和任务循环可正确清理。

### 第三步 跑通本地素材发布

新增明确的素材来源选项，例如“本地素材”和“百度网盘”。配置通过现有 electron-store 保存，由平台主进程注入运行时，renderer 继续经平台 service 调用 IPC。

本地素材模式直接校验用户指定的剧目目录，不隐式触发网盘客户端，也不把缺失素材标记为下载成功。视频、封面、角色资料及权属材料仍按平台要求检查；不完整时给出缺失文件说明。

修复快捷键后，优先验证淘宝标签原生粘贴、抖音表单及视频上传。保留现有任务身份、结果上报、待补报恢复和账号隔离机制。最终提交后，成功页面必须同时满足至少 10 秒停留及平台成功校验；失败页面继续遵守保留配置。

验收：先通过不提交的表单演练，再在明确授权的测试账号和任务上验证真实提交、失败保留及重启恢复。未验收的平台不得统一标记为 Mac 已支持。

### 第四步 完成安装包

- 增加 Mac 构建入口，所有版本固定指定 arm64；构建参数校验拒绝 Mac x64 和 Universal 目标，不生成对应安装包。
- Electron、Chromium、FFmpeg、FFprobe、better-sqlite3、Sharp、Canvas 均按 macOS arm64 准备并验证原生运行，不以 Rosetta 转译运行作为适配完成条件。依赖安装必须使用项目外的现有全局 pnpm store，不创建项目内 `.pnpm-store`。
- 将暂存目录和二进制缓存按系统、架构隔离，防止复用 Windows 二进制或不同架构的旧缓存。
- 检查 ASAR 解包、可执行权限、浏览器应用包完整性和签名处理，验证安装包内部实际加载路径。
- 对打包后的 `.app` 执行 SQLite 查询、PNG 生成、PDF 转图、FFmpeg/FFprobe 调用和浏览器启动检查。

验收：在没有开发环境、未配置全局 FFmpeg 的 M 系列 Mac 上，从 arm64 安装包启动并完成上述检查。构建和验收使用 macOS arm64 环境，Windows 上的构建结果不能代替 Mac 运行验证；不安排 Intel Mac 或 Universal 包验收。

### 第五步 接入网盘全流程

仅在第一步能力验证通过后实施。将客户端查找、进程查询、启动、重启、下载目录和状态检测放入对应系统适配层；保留平台无关的任务调度和文件校验逻辑。

Mac 不支持的操作应在功能入口明确显示状态，不在应用每次启动时重复报错。不得直接套用 Windows 的 `.exe` 启动或客户端适配方式。

验收：分享链接下载、素材标准化、发布、结果上报形成闭环；取消和重启不会重复领取、重复下载或误报成功；多账号共用下载资源时不会互相删除素材。

### 第六步 正式分发和更新

正式分发增加 Mac 签名、公证和安装检查。按当前 Electron 与 electron-builder 版本确认 Hardened Runtime、权限和嵌套可执行文件处理；权限仅按实际功能配置。

自动更新采用 arm64 的 `dmg` 安装包与 `zip` 更新产物，并读取 macOS arm64 对应的更新元数据；不发布或回退到 Mac x64 或 Universal 产物。首版若暂不接入自动更新，应明确显示手动更新入口，不能直接解除 Windows 限制后沿用 `latest.yml`。

版本号由一次发布准备统一递增，现有 Windows 版本与 macOS arm64 版本共用同一版本号。打包子任务不重复加版本。发布前失败可恢复本地版本；若某个平台产物已对外发布，后续失败应重试同一版本或按明确策略发布修复版，不能通过本地回退假装远端产物已撤销。

验收：同一 Release 的 Windows 和 macOS arm64 文件互不覆盖；Mac 更新只下载 macOS arm64 产物；签名后的旧版本可以更新到新版本并保留配置和任务记录。

## 四 配置和兼容约束

1. 保持平台模块边界。系统通用能力进入共享运行层，平台业务仍留在对应 `electron/platforms/`、`src/platforms/` 和 automation 包。
2. Windows 默认行为及现有账号选择、任务生命周期、失败保留策略保持兼容，不批量重写用户配置。
3. Windows 的浏览器 profile 和绝对文件路径不直接迁移为 Mac 可用配置。Mac 首次使用需重新选择素材目录并登录账号。
4. API Key 继续使用 Electron safeStorage；跨系统迁移时重新录入，不导出明文密钥或复制系统绑定密文。
5. 本机 OCR 在 Mac 上采用已有 AI 回退。剪映桌面自动化已从项目移除，不纳入适配范围；发布任务使用的剪映工程截图上传及权属材料识别继续保留。
6. 每阶段单独提交、记录验收结果，便于回退。数据库若确需迁移，先定义兼容和备份方案；不随适配任务顺带更改任务协议。

## 五 验证清单

| 层级 | 必测项目 |
| --- | --- |
| 单元测试 | 系统与架构解析、浏览器路径、素材模式、快捷键选择、更新产物选择、清理路径边界 |
| M 系列 Mac 桌面测试 | arm64 原生运行、菜单、输入快捷键、标题栏、Dock 恢复、窗口关闭与应用退出、目录选择、日志查看 |
| 平台测试 | 账号列表、选中账号启动、账号数据隔离、表单、角色资料、上传、提交及成功校验 |
| 媒体测试 | FFmpeg 转码、FFprobe 探测、Sharp/Canvas、PDF 转图、中文及空格路径 |
| 恢复测试 | 网络中断、上传失败、应用退出、重启、待补报、人工核实记录、失败页面保留 |
| 安装测试 | 干净 M 系列 Mac 安装 arm64 包、应用移动到 Applications、签名检查、arm64 原生模块和嵌套浏览器启动 |
| 更新测试 | 只选择 macOS arm64 产物、正确元数据、下载失败重试、保留配置和数据库 |
| Windows 回归 | 原有发布命令、账号选择、网盘、转码、任务提交与更新不退化 |

基础检查沿用仓库要求：

```bash
pnpm exec tsc --noEmit
pnpm --filter @dramabridge/wechat-drama-automation check
pnpm --filter @dramabridge/wechat-drama-automation build
```

同时执行本阶段涉及的 automation 包 `check`、`build` 和相关测试。仓库已使用 Vite Plus，前端和 Electron 构建使用现有 `pnpm build:app`；需要直接验证构建时使用 `pnpm exec vp build`。实际打包检查与源代码构建检查分别记录。

所有待执行检查均为计划项，不代表已经通过。阶段验收记录应包含系统、CPU、应用和浏览器版本、测试任务及结果；真实平台提交单独确认测试对象和授权。

## 六 审阅事项

- 已确定的架构范围：仅适配 M 系列 Mac arm64，Intel x64 和 Universal 均不在计划内；现有 Windows 功能继续保留。
- 是否接受首版本地素材发布，百度网盘完整流程单独验收。
- 首轮真实发布是否以淘宝、抖音为验收平台。
- 首版采用手动更新，还是同时接入签名、公证和自动更新。

这些选择影响交付边界。公共路径、浏览器定位、快捷键和打包架构修复可以先独立实施；Mac 网盘完整流程须以实机能力验证结果为前提。

## 七 技术参考

- [electron-builder v26 macOS 打包与架构配置](https://www.electron.build/v26/docs/mac/)
- [Playwright Keyboard 跨平台快捷键](https://playwright.dev/docs/api/class-keyboard)
- [Electron 原生菜单](https://www.electronjs.org/docs/latest/api/menu)
- [Electron 应用打包与签名](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)
