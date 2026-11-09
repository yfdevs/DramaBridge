# 百度网盘 macOS 兼容性分析与实现

2026-11-09，本机百度网盘 Mac 8.9.7（build 497，`com.baidu.netdisk`）的连接适配已实现。首次准备独立运行时、客户端启动、CDP 连接、原生下载任务及历史读取、主进程本地文件读取均已实测通过。真实账号的上传、下载、转存和分享尚未提交验证。

## 启动方案

百度安装包保留在 `/Applications/BaiduNetdisk.app`，不复制或重签它的应用包，不改动其签名、fuse、原生模块或受保护的登录容器。

启动器从已安装框架的 Info.plist 读取 Electron 版本，按宿主架构下载相同版本的官方非 MAS Electron。8.9.7 的本机框架版本为 **26.2.0**，原生模块 ABI 为 **116**；直接使用项目自身的 Electron 44 会产生 ABI 不匹配，不能作为备用方案。

下载来源限定为 Electron 官方 GitHub Release，使用同一 Release 的 SHASUMS256.txt 校验完整 ZIP，再解压运行。HTTPS 重定向保持 HTTPS；下载或校验失败不会启动。运行时缓存保留全树内容摘要以识别损坏，替换时不覆盖可能正在运行的旧目录。

本机官方 arm64 ZIP 的 SHA-256 为 `1bb9f1f9d26b045ffa695ed0e73d5e92b0bbbe7adb9c0565585a5c4cd3bc6720`。

独立运行时加载项目生成的普通 app 目录，随后加载安装包中的原始 `app.asar/dist/electron/entry.js`。启动器维持原始资源路径和原生模块搜索路径，提前设置 CDP 端口，并限制在 `127.0.0.1`。端口直接写入生成入口，不从可能已被 Electron 消费的 process.argv 中提取。

Mac 默认工作目录为 `~/Library/Application Support/DramaBridge/baidu-netdisk-cdp`，其中 mac-profile 是独立的持久化客户端配置。桌面端和直接调用包使用同一默认位置，业务任务目录改变不会迁移登录配置。首次使用可能需要在客户端登录；不复制、读取或解密原 App Store 客户端的受保护账号数据。

## 已实现的适配

| 范围 | 行为 |
| --- | --- |
| 安装发现 | 搜索系统及用户 Applications；接受 BaiduNetdisk.app、其父目录和 Contents/MacOS 下的启动文件 |
| 进程生命周期 | Mac 使用 ps 发现百度主程序及带专用标记的托管运行时，SIGTERM 后等待退出；排除普通 Electron 和 renderer/helper 进程 |
| 连接状态 | 保留 isWindows，新增 supported 和 os；Mac 不再被主进程启动检查或 renderer 按钮排除 |
| 安装选择 | Mac 可选择应用包，提供 Applications 默认位置及 Mac 路径提示，继续使用 electron-store 保存配置 |
| 下载入口 | 开放 darwin；默认本地目录为 Downloads/DramaBridge，桌面端继续注入业务下载配置 |
| 任务路径匹配 | POSIX 路径保留大小写，Windows 盘符及 UNC 路径继续忽略大小写；目录边界阻止匹配同名前缀的兄弟任务 |
| 任务控制 | 支持 POSIX 独立目录，拒绝根目录、用户目录、卷根目录和路径穿越；保留未知状态保护与原生删除确认 |
| 错误处理 | Mac 启动异常写入项目运行记录并退出，连接端报告原因；不让入口异常留在 Electron 默认弹窗中 |
| Windows | 保留原有 EXE 发现、PowerShell、taskkill 和备用启动器流程 |

实现位于百度网盘 automation 包、Electron 平台模块和对应 renderer 服务及页面，没有向共享 UI 或其他业务平台复制百度逻辑。

## 损坏提示的处理

早期测试曾复制百度签名主程序到自建应用包，并修改启动入口。这种组合不能保持原应用资源签名；另有一版入口依赖命令行参数，触发 BAIDU_CDP_PORT_INVALID。这两条测试路径已撤回。

相关测试进程已停止，临时应用副本已删除并撤销其 LaunchServices 注册，原 `/Applications/BaiduNetdisk.app` 路径已重新注册。最终方案使用普通外部入口和未修改的官方 Electron 运行时，不再生成百度应用包副本。

原安装包的 `codesign --verify --deep --strict` 和 macOS 执行评估通过。本项目不通过关闭 Gatekeeper、清除隔离标记或修改原程序签名来解决启动问题。

## 本机验证

最终项目入口实测返回 `supported: true`、`os: darwin`、`cdpRunning: true`、`ready: true`、`launchMode: managed`。启动调用结束后，端口继续监听在 `127.0.0.1:9337`。

只读客户端探测确认以下方法存在：

- 下载提交、任务列表、任务计数、暂停、恢复、活动任务删除、完成记录删除。
- 上传 addFiles、任务列表、历史、暂停、恢复、删除。
- 主进程 `$getHistoryRecord`。

实际调用活动下载快照和下载历史，均返回 errorNo=0、count=0。通过与上传读取路径相同的 remote 主进程 VM 入口读取项目临时测试文件，SHA-256 一致；测试文件随后删除。方法存在与只读成功不代表真实云端写操作已验收。

自动验证结果：

- 百度网盘包完整测试：205 项，其中 204 通过，1 项 Windows 专用进程测试在 Mac 跳过。
- 百度桌面集成测试：6 项通过，包含 Mac 应用包路径保存、错误配置保留、Mac 平台状态、任务清理及重新下载保护。
- 根 renderer、Electron 和百度包类型检查通过。
- 百度包构建、微信自动化检查及构建通过。
- 仓库没有独立 vite 命令，按现有 Vite Plus 工具链执行 `pnpm exec vp build`，renderer/main/preload 构建通过。

## REA 静态证据

本机 Info.plist 注册 baiduyunguanjia scheme，但本次没有将其作为分享或下载自动化协议；连接使用 CDP。

Electron Framework 包含 x86_64 与 arm64 slice，两个 slice 的 RunAsNode 和 EnableNodeCliInspectArguments fuse 均关闭。框架架构不能单独证明所有原生插件的架构覆盖。本次实际运行验证为 Apple Silicon arm64；Intel 路径和下载选择有实现及测试，未在 Intel 实机运行。

Mac core.asar 静态存在与既有实现相近的 addDownloadTask、getDownloadTasks 和 getHistoryRecord 包装器，原生列表使用 browser_engine_get_task_items。运行验证采用现有包装器而非盲猜其他 FFI 名称。

证据索引：

- plist：`ev_8173291fdeb1550a6bd23fb52bd02b277bda43094eeb0378b24461969db32a1d`。
- fuses：`ev_62ebc60a97dbcbe8dbc5c5f17f7daae0684902df5baf8999c76c7785e57c672a`，框架 SHA-256 `9ada09b188da2548ad9605a3628f6d8c5fcc0249d602c4738b52f5d5c5ab2ef1`。
- app.asar 父证据：`ev_7d7ddb094241b4e3a669a8401aaa83299d7323cc78b3a5c38199bce8ffd3b7d3`；摘要：`ev_3aa2e139d2383cafc7c2405e323471dcf7e86694167d3fd8be016584f8bcdf95`。ASAR SHA-256 `ebccf488d11bcf9ab6f2bfb366607d306fbb7d747a66c5034cee7520afb60139`。
- core.asar 部分证据：`ev_39ca8412d1f4b6dbed147096752c54648b22c67449ead2e57c18e58cf9e126b3`，语义分析达到 20 秒预算，不代表完整调用链覆盖。

REA 对 app.asar 的记录包含 16 项 unpacked 文件完整性声明矛盾，采用 record-and-continue 并保留 observed-untrusted 标记；不能据此单独认定客户端被篡改。原应用整体签名验证与这些 ASAR 内部声明是不同的校验面。混淆恢复因缺少 Wakaru provider 未执行。

完整初始 Evidence 保存在本机临时目录 `/var/folders/k_/41pk1_713tn62hpmppl4c9rc0000gn/T/baidu-mac-rea-FQKanA/evidence.json`，未将约 445 MB 的原始结果加入仓库。

## Electron 中的运行时文件操作

运行时 ZIP、应用包和 ASAR 文件通过局部的 artifact-filesystem 边界读取和清理。在 Electron 主进程使用 original-fs，在普通 Node 中使用 node:fs，不改变全局 process.noAsar。这样 Electron 不会将 default_app.asar 作为虚拟目录参与运行时摘要或递归删除。

11:02 的 ENOTEMPTY 报错来自失败清理阶段，遗留目录中只剩 default_app.asar。该目录已清理；修复后，在真实 Electron 44 主进程中能复用原 Node 创建的运行时缓存，完整连接入口返回 ready=true，且没有再次下载。清理设置有限重试，最终失败时记录清理错误并重新抛出原始下载、解压或校验错误。

新增回归验证：四项运行时单元测试通过，覆盖清理失败保留原始错误；一项真实 Electron 集成测试通过，覆盖跨宿主缓存复用、ASAR 原始字节摘要，以及含 ASAR 的部分解压目录清理。修复后的主项目及相关包类型检查、百度及微信包构建、Vite Plus 桌面构建均通过。
