# YouTube 桌面桥接

DramaBridge 的独立 YouTube 平台。复用 `drama-vox` 的 Python 下载、视频合并、人声分离、Google 多账号授权、断点上传和任务控制流程。原项目不需要同时运行。

## 首次使用

1. 打开 YouTube → 配置管理，填写代理端口或留空直连，点击“安装依赖”。无需预装 Python，也无需管理员权限。
2. 应用优先复用专用环境；若所选 Python 不可用或版本过低，自动下载 Python 3.12，创建 `python-env` 并安装依赖。Python 文件为可选项。自动下载支持 Apple Silicon macOS、Windows x64/arm64。安装阶段见配置页及实时日志，首次处理还会下载人声模型。
3. 在 Google Cloud 项目启用 YouTube Data API v3、配置 OAuth 同意屏幕，创建“桌面应用”客户端。导入下载的 `client_secret.json`。测试状态需将上传账号加入测试用户。
4. 启动 YouTube 服务，在“账号管理”页添加账号并完成浏览器 Google 授权。
5. 配置全局素材目录及百度网盘连接，在“添加任务”页填写分享链接、剧名、集数、上传元数据后加入队列。默认上传为私密。

配置页的“检查环境”无需启动服务即可检查 Python 版本、依赖及应用自带的 FFmpeg/FFprobe。未就绪时拒绝创建任务。macOS 当前使用 CPU 分离；未声明或验证 MPS 加速。YouTube 上传依赖账号授权、API 配额和可用网络。

## 边界与存储

- `electron/platforms/youtube-drama/` 管理 IPC、electron-store 配置、子进程和凭据导入。
- `src/platforms/youtube-drama/` 提供 renderer IPC 客户端；`src/pages/youtube-drama/` 为原生 React 工作台和配置页。
- Python 源码作为 extraResources 随 macOS/Windows 构建打包，启动时复制至可写的全局运行数据目录下 `youtube-drama`；`data/queue.sqlite3` 保留任务及账号，`data/credentials` 和 `data/youtube-accounts` 保留授权文件。
- Python 通过 stdin/stdout 向 Electron 请求百度操作，直接复用现有下载管理器；无需开启外部 HTTP API。桌面进程内部 HTTP 仅监听随机 loopback 端口，使用每次启动生成的随机令牌；Google 回调单独校验 OAuth state。端口及令牌不会传给 renderer。
- Python 业务配置由 Electron 注入并回写 electron-store；不读业务环境文件。任务数据库和子任务事件环境变量只承载队列/进程协议。
- 停止服务或退出应用会关闭 Python worker 及其处理子进程。临时文件独立保存在 `work/tasks/<任务编号>`：成功后立即清理，失败或取消超过 24 小时清理；活动及暂停任务受到保护。原始下载素材不参与此清理。
- Python、虚拟环境和模型按需下载到独立运行目录，账号令牌也保存在此目录；均不随安装包分发。系统 Python、PATH 和 Windows 注册表不受影响。

## 源码来源与验证

上游为本机 `../drama-vox`，版本及原始文件校验和见 `python/UPSTREAM.json`。桌面入口为新增的 `desktop_bridge.py`；人声设备选择改为自动探测 CUDA/XPU、回退 CPU，线程数从 CPU 数量派生；授权回调页面改为返回 DramaBridge。

执行 `pnpm youtube-drama:check`、`pnpm youtube-drama:build`、`pnpm youtube-drama:test`。`tests/electron/youtube-bridge-smoke.test.ts` 检查实际 Electron 页面、配置 IPC、Python 生命周期和自带 FFmpeg 路径。桥接测试不调用真实百度下载、模型推理或 Google 上传；这些需要用户环境及授权后验证。

## Web 访问

YouTube 服务启动时会同时监听 Web 端口（默认 `18440`），停止服务或退出应用时一并关闭。桌面配置页可修改端口，并显示本机及局域网访问地址；任务页提供“打开 Web”。

浏览器打开地址即可查看队列、添加上传任务、管理账号并发起 Google 授权。桌面和 Web 使用同一 Python worker、任务数据库及百度下载管理器。Web 不提供桌面配置、环境安装或凭据文件导入；这些操作在桌面完成。

同一台电脑可由 Google 自动跳回本机 Python 回调。其他电脑使用桌面应用 OAuth 的 loopback 回调时，最后跳转的 `127.0.0.1` 页面可能无法连接：复制地址栏的完整回调地址，回到 Web 账号页提交。服务端校验本次 state、回调地址、有效期及 PKCE，授权令牌始终保存在运行 DramaBridge 的电脑上。实际 Google 授权与上传仍需有效客户端凭据、Python 依赖及网络；自动测试使用模拟 Google 流程，不访问真实账号。

Web 监听 IPv4 局域网，无需登录，保留同源检查及接口白名单。访问地址是 HTTP 局域网地址，不包含公网域名或 HTTPS 部署。

前端由根目录 `youtube-web.html` 与桌面页面一起构建到 `dist/`，安装包自动包含这些资源。源码开发时需先运行应用构建生成 Web 静态文件，再启动 YouTube 服务。

## 一键准备环境

安装工具固定使用 uv 0.13.7 的官方 PyPI 平台 wheel，校验固定 SHA-256 后仅提取可执行文件到 `python-tools`。uv 将 CPython 3.12 安装在 `python-runtime`，禁止写入系统 PATH 或 Windows 注册表，再创建 `python-env` 安装依赖并实际导入验证。成功的 Python 与虚拟环境会复用；缺少 Python 或版本过低时自动准备，不再直接退出。

安装优先使用配置代理，网络失败时尝试直连。界面显示当前阶段，退出应用会中止下载及安装。安装缓存 `python-cache` 在结束时回收，pip 禁用额外下载缓存，避免重复积累大体积安装包。

## work 安全清理

合并视频、音轨、人声分离结果及上传中间视频统一进入各任务的专属临时目录，上传完成并确认成功后立即清理。启动时及每 5 分钟补扫遗漏目录。失败或取消超过 24 小时清理，重试会清除旧下载编号和本地记录，重新进入下载与处理流程；任务历史和上传链接保留。磁盘紧张时优先回收已停止任务的临时文件。

删除须同时通过任务编号、目录归属标识、数据库状态及独占文件锁校验。拒绝符号链接、Windows junction/reparse point 和越界路径；先原子移入清理区，再回收文件。清理区保留绑定目录 inode 的归属记录，可在中断后重试清理。活动、排队和暂停任务受到保护；原始素材、授权文件与 Python 环境均不属于删除候选。

处理前检查剩余空间，至少预留 2 GiB，并按素材体积估算工作空间；处理中每 2 秒检查磁盘，低于 512 MiB 时终止处理并回收失败临时文件。`python/tests/test_task_workspaces.py` 覆盖完成后清理、失败过期和重新下载、文件锁、链接攻击、路径越界、清理中断恢复、空间不足及输出隔离。

### 静音处理

同步 drama-vox `3ff3168`：添加任务可选择“合并静音”，按集数合并并移除全部音轨；可选“高画质压缩”，仅在文件更小时采用压缩结果。桌面端和 Web 共用此功能。静音输出同样放入任务专属工作目录，遵循成功立即清理、失败超过 24 小时清理的规则。
