# 百度网盘 8.9.7：上传协议与下载任务接口调查

调查日期：2026-10-30。范围为本机安装包中的指定 JavaScript 源码；没有执行提取的源码，没有提交真实上传、下载或删除请求。以下静态事实不代表本次线上错误已复现。

运行态通过 REA `list_electron_targets` / `inspect_electron_page` 被动核对版本与加载脚本：`ev_4a14d839f7d1f28ecabca05dbcb8ab322c7dead46e5163f184813f1294e07e90`、`ev_f7568e2148a10e70de7c36b041567dca5f554331c38ee3c7bb155c6472a784a4`。观察有目标/来源过滤，不包含历史网络行为，不能把文件路径当作运行代码字节一致性证明。核心包 SHA-256 为 `280214b601b9dd28b932879c931d7bc9735bfd39b231e99412327aa3ea8c71c2`。

补充 REA 选择上传主入口、H5 与验证组件的父证据为 `ev_85f654ae0c5904962d0a111a8ce40de5065e0390308ebf20f92daaacbbac2068`：3 个文件语法解析成功，语义保留达到上限，覆盖部分。对 `core.asar/main.js` 的 AST 分析达到单文件 45 秒预算，残留证据 `ev_16c0bd1c9ed93327aaa4e5a58475cbdb224168fe4ab2e285527bf5fcc3f7ddee` 不含已完成语法解析；以下核心接口结论来自直接只读精读，未将超时分析描述为成功反编译。

## 来源与可复用证据

- 安装目录：`%APPDATA%/baidu/BaiduNetdisk/module/BrowserEngine/resources/`。
- `app.asar` SHA-256：`f4e24518e4ed7372a0235df2259084efef30cfdfd53d78bc94134eefdaf8a64f`。
- REA `analyze_javascript_application`：精确选择 `node_modules/@baidu/wp-upload/src/xhr/index.js`，成功解析一个文件，2357 个 AST 节点、7 个 findings、0 个解析失败。
- 完整父证据：`ev_b7555a965eb058b88a4e6ccea12ef248bd38367a723836665098934343a8c38f`；摘要：`ev_5eb917e4d739adb07698375d62301ffab415f539b705400c35c87593b1fe36b6`。
- 完整应用图是部分覆盖：仅选择一个源码，不隐式分析依赖，未选择源码和 native 实现仍未知。下列其他文件为本地 ASAR 只读精读证据。

位置中的偏移为解码后 JavaScript 字符串的 UTF-16 下标，不是 ASAR 文件偏移；升级后必须重新核对。

## 网页上传协议

`node_modules/@baidu/wp-upload/src/main/index.js` 第 73 行起的默认配置：网页端采用 `app_id=250528`、`channel=chunlei`、`web=1`、`clienttype=0`。上传定位接口是 `https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locateupload`，具体默认域名可由页面配置覆盖。

`src/xhr/index.js` 第 183 行起 `_locateUpload`：

1. 请求定位接口，响应 `server` 是 host 字符串数组，不是完整上传 URL。
2. 使用第一项作为上传 host，并保留整个数组供后续选择。
3. 追加默认服务器（通常 `c2.pcs.baidu.com`）。
4. 本地缓存的实际有效期是 60 秒。源码注释称十分钟，但条件是 `60 * 1000`，实现优先于注释。
5. `_setServerUrl` 组合 `//${host}/rest/2.0/pcs/superfile2?method=upload` 并追加 `logid` 和上述网页参数。

`src/uploader/h5/index.js` 第 483 行 `_compileUrl` 追加 `path`、`uploadid`、`uploadsign`（无值时为 0）、`partseq` 和 `dp-logid`。仅在 `isWp=false` 的开放平台分支追加 `access_token` 与 `type=tmpfile`。普通网页分支使用 cookie，会设置 `withCredentials=true`。

`src/xhr/index.js` 第 267 行 `preCreate` 的 POST 字段是 `path`、`autoinit`、`target_path`、`block_list`，可带时间字段、续传的 `uploadid` 和 `uploadsign`。第 307 行 `create` 的 POST 包含完整 `path`、`size`、`uploadid`、`target_path`、`block_list`，有签名时携带 `uploadsign`。

`target_path` 来自 `file.server_path || options.uploadPath || '/'`，代表文件目标父目录；`path` 是含文件名的完整路径。不能用本地路径替代。

### 签名的边界

H5 源码第 176 行（UTF-16 下标 6044）明确说明 `uploadsign` 只有共享目录才会用到。不能将普通个人目录缺少 `uploadsign` 定性为此次错误的根因。但服务器返回签名时，应原样用于分片和最终提交，不能捏造签名。

### 可实施的备用策略

- 按定位接口选择服务器；只接纳 HTTPS 且属于受支持百度 PCS 域的 host，拒绝 userinfo、路径、端口和外域，避免把会话 cookie 发给任意地址。
- 网络故障只重传同一 uploadid、同一 partseq 的分片，必要时切换定位结果内的服务器。
- 不把创建文件、创建分享等最终写操作作为普通请求盲目重放；先读取目标结果，核对文件身份后再决定恢复。
- `8001` 等验证/风险返回不得通过切换上传服务器或重新登录循环绕过。暂停自动请求，提示用户在客户端处理。

## 原生上传备用入口

`core.asar/main.js` UTF-16 下标约 451449 起 `addFilesInternal`，453007 起 `addFiles`，以及约 1111918 的真实调用：

- 主进程入口是 `app.$uploader.addFiles(files, remoteParent, '0')`。
- 文件对象有 `local_path`、`is_dir`；renderer 的 `addUploadTask` 是 store action，不能推定为主进程同名 API。
- `addFiles` 可能异步检查绑定手机并弹出绑定提示；容量、文件大小等也有界面路径。因此返回 true/0 不代表最终上传成功。
- 原生方案必须配套任务出现确认、任务结束确认和云端内容验证；没有这些验证时，不应在网页上传失败后直接盲交另一套上传任务。

## 原生下载任务列表与控制

`core.asar/main.js` 约 646374 起公开入口是 `getDownloadTasks(callback, id, limit, cid)`，默认 limit=1000、cid='0'；helper 调用 `browser_engine_get_task_items(cid, true, Number(id), 0, limit, callback, outInt64)`。

原生 callback 签名是 `(int32, int64, string, int32)`；JavaScript 将第三项 JSON 解码为对象，或 `{}`，透传 `(errorNo, flag, items, count)`。renderer 消费 `items.tasks || []`，忽略 flag/count。完成历史走独立接口。不能把 flag 猜作 completed。

`count` 的来源是原生 callback，不透明 native 实现没有在本次调查中反编译，无法仅凭这些 JavaScript 证明它是总量。客户端 `hasMore` 实际由独立 `getDownloadTaskCount` 的 running/waiting/paused/failed 总和与最大拉取量比较得出。若 count 大于已返回条目数，拒绝据此断言任务缺失，是保守保护而非已证明的分页协议。

约 6469xx 起的真实任务控制入口：

- 暂停：`app.$downloader.pauseTask(idsArray, cid)`。
- 恢复：`app.$downloader.enqueueTask(idsArray, cid)`。
- 删除活动任务：`app.$downloader.deleteTask(idsArray, cid)`。
- 删除完成记录：`app.$downloader.deleteCompletedTask(idsArray, cid)`。

这些包装器会对 idsArray 做 JSON.stringify 后交给 native。传单个字符串会形成 JSON 标量，不能代替数组；未发现的 `removeTask` / `deleteDownloadTask` 名称不应用作盲猜备用接口。只能筛选本任务独有本地目录内的 IDs，不调用全局 deleteAll。

### 完成历史备用查询

虽然 `$downloader.getDownloadHistory` 方法仍存在，其 helper 使用五参数旧调用，而当前 `browser_engine_get_history_items` FFI 定义有七参数；存在性检查不能证明这个旧封装兼容，切勿直接当备用接口使用。

真实 completed store 在 `renderer.js` UTF-16 62985xx 使用 `app.$getHistoryRecord(id, callback, type, cid, lastOptime, count)`。主进程包装在 `main.js` 542650 附近，按顺序传七个 native 参数，callback 原样透传 `(errorNo, flag, rawJSON, count)`；记录从 `JSON.parse(rawJSON).history_items` 取得。

`renderer.js` 49373 的类型枚举是 `{UPLOAD: 1, DOWNLOAD: 2, ALL: 3}`。因此有界下载历史读取可用 `app.$getHistoryRecord('', callback, 2, '0', 0, 200)`；这是来自静态客户端调用链的签名，不是本次执行结果。历史字段有 `trans_id`、`is_download`（字符串 '1' 表示下载）、`local_path`、`op_endtime`。完成记录删除用 `trans_id`，不能混淆活动任务的 `id`。

历史只应用于匹配本任务路径的正向完成确认。200 条内没找到不能证明任务不存在；不可用历史应视为未知，不能授权重复提交。客户端用共享 callback 变量承接请求，也应避免同时发多个相同类型的 native 查询。

历史位于 completed store 并不证明每种原生记录都成功。本次未确认失败/取消历史的包含规则和状态枚举；不要仅因出现在历史中就强制 `completed=true`，仍需本地完整性检查。

### 同类型原生查询的并发限制

`main.js` 活动下载 helper 在 `getDownloadTasks` 中执行模块级 `d = callback`，native callback 再调用当前 `d`；历史 API 同样通过模块级 `gn` 保存 callback。并发相同类型查询可能覆盖 callback。应按客户端端口排队或共享同一只读快照，再对每个调用者独立筛选结果。不能只给写入流程加锁，而让多个下载监控同时调用这个回调槽。是否已导致本机某次超时仍需运行证据。

只读诊断命令：`node internal/research/inspect-baidu-client.mjs`。默认检查本机 9337，可另传本地 HTTP CDP 地址。它只读取版本、脱敏 target 和方法存在性，不调用任务方法、不读 cookie、不导航。方法存在并不证明所有参数兼容。2026-10-30 的一次检查确认原生上传/下载方法存在，运行 UA 为 `baidunetdisk/8.9.7`、`Electron/22.3.27`。

## 风险码

补充 `132` 调查：`core.asar/main.js` UTF-16 偏移约 474872 将其映射为“您的账号存在安全风险，请验证身份后操作。”；`31.js` 约 6649 的删除回调在 `errno===132` 时通过 `deleteFileSecurity` 交由客户端处理身份验证。本次没有调用该 IPC 或代替用户验证。REA 精确分析 `31.js` 的父证据为 `ev_f0af11872b6915abfb814aec058f9a30a0260362a42195d4aa7a518e1e8022d1`，摘要 `ev_dc544b41b44a158fcc9ab5ca667ce80868ac50994547b1461ffeb278f070585c`：一个文件成功解析、6660 AST 节点、2 findings、0 解析失败；仅选定源覆盖。

项目将 132 归入当前操作的身份验证错误，使用独立标记 `BAIDU_NETDISK_IDENTITY_VERIFICATION`，保留 request_id 并说明正在删除/重命名的具体路径，不开启全局上传暂停。完整上传、校验及创建有效分享后，旧的同级尝试目录清理作为可选维护；被拒绝时保留旧目录和分享结果，后续上传仍可继续。分享目录内的必要冲突清理仍然阻断，避免把混杂内容分享出去。此调整不绕过百度的身份验证，也不解除独立的 8001/8011 风控暂停。

运行日志核对：2026-10-30 14:09:00 上一版本上传和分享已成功，可选旧目录清理返回 132（request_id=100377601569376720）；旧代码把该结果升级为所有网盘操作暂停，14:09:05 下一版本尚未请求百度即被阻止，截止 14:10:00。这是项目暂停范围过宽的实证，不能把这条本地暂停提示当作百度新返回了 8001。上述独立错误分类修正了这一传播问题。

`core.asar/main.js` 约 471472、486223 处将 `8001` 映射为账号环境风险；`renderer.js` 的验证组件也声明 `verifyCode:8001`、`timesCode:8011`。这说明应保留用户验证通道，不证明本次风控一定由请求频率导致。

降低目录搜索、递归比对和重复列表读取的次数，配合串行限速、短期缓存、写后局部失效以及有上限的退避，有助于降低自动化产生的请求压力。实际触发原因还需要首次错误请求和客户端网络响应的时间关联证据。

## 原生列表回调并发与本次改动

`main.js` 的任务 getter 将回调保存在模块级变量；新的查询可能覆盖上次回调。项目现在按 CDP 端口串行执行自己的原生列表查询、历史备用查询和任务控制，避免多个平台的轮询互相覆盖。客户端 UI 的查询不受该队列控制，因此超时仍记为“未知”，不能据此补交任务或断言任务不存在。

本次同时落地单任务目录缓存、完整根目录命中后跳过全盘搜索、渐进转存回查、400ms 请求起始间隔、60 秒风险暂停、上传服务器发现/受控故障切换、最终写入结果核对、精确文件元数据查询与分享前整树复核。上述间隔是项目的保守实现选择，未经百度公布为安全阈值，也不保证消除风控。失败的任务取消未经确认时，保留临时文件和中转清理标记。

本机任务数据库未留存用户此前描述的上传失败响应：调查时一个任务仍在上传，另一个失败在下载阶段（29/31 集）。所以本次修复了确定的协议偏差与恢复缺陷，并通过模拟故障测试验证；真实账号的上传到生成分享链接仍需在当前运行结束、加载新代码后复验。

## 验证记录

第二轮流水线提速：两个文件并行，每文件四片，总分片请求预算八路；共享节点只预热一次，分片起始间隔 20ms，目录/元数据保留 400ms。分片改为客户端主进程直接读取本地文件，CDP 仅发送路径/偏移/长度/时间/MD5 描述，不传大块 Base64；发送前检查文件状态和分片哈希。传输与另一文件的回读校验重叠，失败会取消并排空同批工作；并发目录缓存更新改为链式合并，完整提交响应复用为元数据。保留全部内容验证及最终分享前复核。新增本地直读、读盘取消、文件流水线、跨文件验证取消和并行缓存测试，整包 135 项通过，类型检查和构建通过。真实账号吞吐仍需实测；每次启动上传会记录 `local-file-v2`，并保留文件传输速度、合并/校验耗时及批次耗时，可确认加载了本轮代码并定位后续瓶颈。

上传提速补充（项目实现选择，不是逆向测得的百度安全阈值）：4 MiB 分片在单片预热后最多 3 路并发；PCS 数据请求起始间隔为 80ms，目录/元数据仍为 400ms，两者共享风险暂停。并发失败会取消同批工作并等待其结束，未确认全部分片成功不合并文件；保留完整内容校验及断点凭证。节点发现过期刷新复用同一 Promise。完整模拟上传验证了实际 CDP/客户端网络请求并发达到 3，整包 129 项测试通过；尚未对真实账号实测提速倍数。

- 百度网盘包完整测试：122 项通过，覆盖目录缓存、队列并发、风险暂停、任务控制、历史备用、上传节点故障切换、提交响应丢失后的核对、校验凭证复用。
- media-assets 百度下载相关测试：18 项通过；百度安装目录 Electron smoke 测试通过；快手二创 workflow 的 3 项测试通过。
- 主项目 renderer 与 Electron 类型检查，百度网盘、快手和微信自动化包类型检查通过；百度网盘、素材和微信自动化包构建通过。
- 本仓库使用 Vite Plus，原 AGENTS 的 `pnpm exec vite build` 因没有独立 `vite` 命令不可用；等价的 `pnpm exec vp build` 已通过，包含 renderer/main/preload 构建。
- 未重新提交真实账号素材，未重启现有百度客户端，未修改客户端安装包。自动测试通过不代表首次 8001 的触发原因已被实证确定，也不代表账号端到端上传已复验。
