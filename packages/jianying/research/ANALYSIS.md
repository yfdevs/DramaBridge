# 剪映自动化接入调查

调查日期：2026-11-20。对象为本机剪映专业版 **11.6.0.14552 / Windows x64**。

本文保留首次调查结果。后续针对“前六集素材、第一集入轨、分离音频、随机切割、截图”的新增 REA 证据与界面实测见 [整剧工作流调查](DRAMA-WORKFLOW.md)。后续已实现可复用的桌面执行器并通过六集合成视频全流程实测，包括分离音频、原生分割及截图。

## 结论

安装包带有草稿操作 CLI、原生视频编辑组件以及 Agent 宿主能力客户端，值得优先验证这些入口。但本轮未建立可用连接，也未验证剪辑、字幕识别或视频导出成功。

实际运行 `lyra-cli.exe --help` 返回 `unauthorized host process`（错误码 `-100015`），说明直接从当前外部进程调用受限。不能把内置 CLI 的存在当成公开、可独立调用的 SDK。

## 已确认的证据

安装目录：`C:/Users/maded/AppData/Local/JianyingPro/Apps/11.6.0.14552`。

| 观察 | 来源 | 意义与范围 |
| --- | --- | --- |
| 存在 Qt6Core、Qt6Quick、CEF、videoeditor.dll、VECreator.dll、videoeditor_addon.node | 文件系统；REA PE 导入解析确认 CLI 导入 Qt6Core | 原生 Qt 组件与嵌入式网页组件共存；尚未验证主界面控制树，不能直接当成 Electron 应用 |
| CLI 帮助列出 fetch-feishu-doc、query-content、plan-patch、validate-patch、apply-patch | 实际执行 `jianying-agent-cli.exe --help` | 提供草稿查询、规划、校验和应用入口；不是成功执行的证明 |
| CLI 包含 add_clip、trim_clip、split_clip、move_clip、轨道、特效、转场操作名 | PowerShell 静态 ASCII 字符串提取 | 仅为二进制中的候选操作名称，未取得完整输入 schema，未实测 |
| CLI 包含运行令牌、项目 ID、草稿版本与 PC 确认检查相关字符串 | 同上 | 调用存在会话与确认条件；不应伪造令牌或跳过确认 |
| lyra-cli 返回 unauthorized host process | 实际执行 `lyra-cli.exe --help` | 当前外部进程无法正常使用该入口；检查发生在哪一层尚未知 |
| canvas-draft 帮助提供 inspect 与 downgrade | 实际执行 `canvas-draft.exe --help` | 是画布快照检查/降级入口，未确认能操作常规时间线草稿或导出视频 |
| hubcli contracts 定义 asset.list、asset.get、asset.import | 安装包 contracts.json；REA 分析配套三份 mjs | 是素材管理入口，不能据此推断已有导出、时间线编辑 API |
| host-capability-client.mjs 支持 HTTP、Unix socket、named pipe、file-rpc | 安装包脚本文本 | 使用宿主发放的令牌；file-rpc 支持 HMAC。没有发现可直接使用的固定端口或当前有效会话 |

`jianying-agent-cli.exe` 的 SHA-256：`ddbb2a9dda9b60fc12c78b5c60a0cc582dc8ade1fdcb0876a3e93ee3da499184`（REA PE 导入解析）。

本机默认 `User Data/Projects/com.lveditor.draft` 存在且有目录条目，但本轮没有读取用户草稿内容，也未确认实际配置的草稿根目录。

## 通信结构推断

根据文件和脚本推断的候选链路，并非已连通链路：

```text
DramaBridge Electron 工具模块
  → @dramabridge/jianying
  → 剪映支持的宿主/CLI 或界面控制
  → 草稿处理与剪映渲染导出
```

宿主能力客户端默认路径为 `/api/custom-agent/host-capabilities`，请求包含 capabilityId、requestId 与 input。脚本通过宿主注入的环境变量取得传输描述和令牌。这属于剪映内部运行协议，不是本项目应读取环境文件的业务配置；项目接入时应由 Electron 注入连接参数。

## 接入路线

1. **优先验证合法宿主入口**：在剪映实际启动的会话里查找正式支持的自定义 Agent/扩展入口，确认宿主如何发放连接能力。成功后才能测试一个新建测试项目的查询、修改、导出链路。
2. **固定模板路线**：用新建测试草稿验证存储格式、素材路径、时间单位与版本兼容，再实现复制模板和替换素材。不要直接修改用户原草稿；新版本草稿是否可读写仍待验证。
3. **界面控制路线**：检查 Qt 的 Windows UI Automation 暴露情况，优先使用控件定位和快捷键；图像定位作为补充。可用于导入、打开草稿、触发导出、读取进度与错误，但本轮尚未测试。

对批处理，建议先完成一个最小闭环：一个本地视频 → 新建测试项目 → 裁剪 → 导出 MP4 → 用 ffprobe 检查视频轨、时长、分辨率与文件完整性。字幕、配音、AI 和付费能力分别验证，不能从草稿 CLI 推定支持。

## 当前工具限制与留存

REA 已执行桌面目录清点、PE 导入解析和 JavaScript 静态分析。原生 search_strings 因 Ghidra/IDA 等引擎未配置而失败，因此没有原生函数反编译或调用链证据。没有为此修改 REA 配置或安装引擎。

目录清点达到表示预算，覆盖为 partial；JS 语义图存在未知关系。`rea-evidence.json` 保存两份实际返回的 REA 内联摘要及其限制，是摘要留存，不是可重放的完整 Evidence bundle。CLI 输出与普通文件读取属于 shell 观察，需与 REA 证据区分。

本轮没有运行 apply-patch、设置允许修改的开关、改变用户草稿、连接云端素材接口或触发导出。

