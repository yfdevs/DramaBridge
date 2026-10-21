# Pinduoduo Drama Automation Flow

本文档说明 `@dramabridge/pinduoduo-drama-automation` 当前真实运行逻辑。它不是目标设计稿，而是按现有代码整理的执行链路、状态转换、页面动作和已知断点。

## 1. 代码边界

拼多多平台相关代码分布如下：

- `electron/platforms/pinduoduo-drama.ts`
  - Electron 主进程平台模块。
  - 负责读取 / 保存 Electron Store 配置、拼装运行目录、启动 / 停止自动化运行时、注册 IPC。
- `src/pages/pinduoduo-drama/`
  - 渲染进程页面。
  - `configuration.tsx` 是配置页，`service-control.tsx` 是启动 / 停止页。
- `src/platforms/pinduoduo-drama/service.ts`
  - 渲染进程 IPC 客户端封装。
- `packages/pinduoduo-drama-automation/`
  - Playwright 自动化包。
  - 包含浏览器启动、任务 API、短剧提报、审核轮询、本地记录、审核通过后的预留流程。

## 2. Electron 启动链路

用户在 UI 点击启动拼多多服务后，链路是：

1. `src/pages/pinduoduo-drama/service-control.tsx`
2. `src/platforms/pinduoduo-drama/service.ts`
   - 调用 IPC `pinduoduo-drama:service:start`
3. `electron/platforms/pinduoduo-drama.ts`
   - `registerPinduoduoDramaPlatformHandlers()`
   - `startRuntime()`
4. 动态导入包：
   - `import("@dramabridge/pinduoduo-drama-automation")`
   - 调用 `startPinduoduoDramaRuntime(...)`
5. 包内入口：
   - `packages/pinduoduo-drama-automation/src/app/runtime.ts`

Electron 侧传入的关键参数：

- `accountProfileName`
- `accountDir`
- `databasePath`
- `userDataDir`
- `credentialStatePath`
- `logFilePath`
- `logRetentionDays`
- `ensureBaiduNetdiskResource`
- `config.browser.headless`
- `config.browser.slowMo`
- `config.taskPollIntervalMinutes`
- `config.video.localEpisodeVideoRoot`
- `config.video.baiduNetdiskDownloadRetryAttempts`

重要现状：Electron 拼多多配置页当前没有暴露 API Base URL，也没有把 `config.api` 传进自动化包。所以在当前实现里，如果没有其他地方注入 `apiConfig`，任务 API 会走包内 mock 逻辑。

## 3. 配置和目录

默认配置在 `electron/platforms/pinduoduo-drama.ts`：

```ts
{
  accountProfileName: "default",
  headless: "false",
  operationDelaySeconds: "0",
  runDataDir: ".drama-runs/pinduoduo-drama",
  logRetentionDays: "3",
  taskPollIntervalMinutes: "120",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3"
}
```

实际目录由 Electron 侧拼装：

- 运行根目录：`runDataDir`
- 账号目录：`<runDataDir>/auth/accounts/<encodedAccountProfileName>`
- 浏览器持久化目录：`<accountDir>/chromium-profile`
- 登录态快照：`<accountDir>/storage-state.json`
- 合同下载目录：`<accountDir>/upload-assets/contracts`
- 日志目录：`<runDataDir>/logs`
- 统一日志：`<runDataDir>/logs/app-YYYY-MM-DD.json`（逐行 JSON，每行一个完整事件）
- 数据库：由 Electron 传入 `automationDatabasePath()`，当前是应用级 `automation.sqlite`

日志实现：

- `src/shared/logger.ts` 使用共享日志包写入可读日志和结构化副本。
- `log(options, level, scope, message, fields)` 是包内统一日志入口。
- 如果传入 `options.onLog`，同一条可读日志也会回调给 Electron 侧。
- 文件日志保留天数由 `logRetentionDays` 控制，启动时执行过期日志清理。

## 4. 浏览器和登录

浏览器逻辑在：

- `src/app/browser-session.ts`
- `src/app/shortplay-manage-page.ts`

启动方式：

- 使用 `chromium.launchPersistentContext(userDataDir, ...)`
- 指定 `channel: "chrome"`
- 使用真实 Chrome 持久化 profile，登录态保存在 `userDataDir`
- 同时在停止时调用 `context.storageState({ path: credentialStatePath })` 保存快照

浏览器参数：

- `--disable-blink-features=AutomationControlled`
- `ignoreDefaultArgs: ["--enable-automation"]`
- `locale: "zh-CN"`
- `timezoneId: "Asia/Shanghai"`
- `viewport: null`
- `headless` 和 `slowMo` 来自配置

登录判断：

- URL 是 `/register` 或包含 `/register`：`login-required`
- URL 以 `https://mcn.pinduoduo.com` 开头：`logged-in`
- 另外会等待接口 `https://mcn.pinduoduo.com/api/cafe/login/user_info`
  - 如果返回 `error_code=40001`，认为需要登录
  - 否则认为已登录

启动后首先打开：

```text
https://mcn.pinduoduo.com/home/shortplayManage
```

如果未登录：

1. 跳转到 `https://mcn.pinduoduo.com/register`
2. 等用户手动登录
3. 检测到登录成功后重新打开短剧管理页
4. 保存登录态快照

## 5. 主循环

主循环在 `src/app/runtime.ts`：

```text
startPinduoduoDramaRuntime()
  -> openShortplayManagePage()
  -> runTaskLoop()
  -> claimAndSubmitNextTask()
```

每轮任务后休眠：

- 默认 120 分钟
- 可通过拼多多配置页的“任务轮询间隔”调整，配置字段是 `taskPollIntervalMinutes`
- 主循环睡眠和审核记录的 `next_check_at` 都使用同一个间隔
- 如果下一次轮询时间落在中国时间 00:00 到 08:00，顺延到 08:00

主循环当前顺序在 `src/app/task-runner.ts`：

```text
1. checkLocalAuditTask()
   - 批量读取所有到期 PENDING 记录
   - 匹配拼多多已提报列表
   - 只负责同步本地 audit_status / video_status
2. runApprovedShortplayQueue()
   - 读取所有 APPROVED 且 video_status 为 READY / RESOURCE_READY 的本地记录
   - 按 updated_at 顺序串行执行
   - READY 先准备本地视频资源，成功后继续打开内容管理
   - RESOURCE_READY 直接打开内容管理
3. claimAndSubmitApplyTask()
4. 如果都没有任务，写日志 no pinduoduo drama task to run
```

这个顺序很重要：

- 本地待审核记录优先级最高。
- 审核分支会处理当前所有到期的 `PENDING` 记录，不限制条数。
- 审核分支不会再因为“本轮检查过审核”而阻断后续上剧。
- 审核检查同步完成后，会把本轮新变成 `APPROVED / READY` 的记录和历史遗留的 `APPROVED / READY|RESOURCE_READY` 记录组装成上剧队列。
- 上剧队列串行执行，单条失败会上报对应失败阶段，然后继续处理下一条候选记录。
- 只有本轮没有审核检查、没有待上剧队列时，才会领取新的提报任务。

## 6. 任务 API

代码在 `src/api/task.ts`。

默认接口路径：

```ts
{
  accountTaskPage: "/pinduoduoDramaRpa/accountTask/page",
  claimTask: "/pinduoduoDramaRpa/rpa/claim",
  successCallback: "/pinduoduoDramaRpa/rpa/successCallback",
  failCallback: "/pinduoduoDramaRpa/rpa/failCallback"
}
```

API 客户端在 `src/api/http-client.ts`，基于 `@dramabridge/axios`。

如果没有传 `apiConfig` 且没有传自定义 `client`：

- `shouldUseMockTaskApi()` 返回 true
- `claimNextPinduoduoDramaTaskApi()` 使用内置 `mockClaimedTask`
- success / fail callback 只写日志，不请求后端

当前 Electron 拼多多启动参数没有传 `config.api`，所以默认是 mock 模式。

领取任务流程：

1. `findNextUnclaimedAccountTaskId()`
   - 请求 `/accountTask/page`
   - 参数包含 `page=1`、`pageSize=100`、`rpaStatus`
   - 当前 `claimOptions()` 只传 `pinduoduoAccountName=accountProfileName`，没有传 `pinduoduoAccountId`
2. `claimPinduoduoDramaTaskByIdApi()`
   - 请求 `/rpa/claim`
   - 解析 `payloadJson` 或 `playlet`
   - 用 Zod 校验成 `ClaimedPinduoduoDramaTask`

## 7. 任务数据结构

核心任务类型是 `ClaimedPinduoduoDramaTask`：

```ts
{
  accountTaskId: number,
  dramaId?: number,
  originalTitle: string,
  pinduoduoAccountId?: string,
  pinduoduoAccountName?: string,
  playlet: PinduoduoDramaTaskPayload
}
```

`playlet` 关键字段：

- `title`
- `contentType`
- `subContentType`
- `isSeriesPlay`
- `copyright`
- `copyrightExpireTime`
- `director`
- `producer`
- `scriptWriter`
- `role`
- `episodeCount`
- `durationMinutes`
- `durationSeconds`
- `cate`
- `labelIds`
- `copyrightAgency`
- `cost`
- `salaryPercent`
- `majorSalaryPercent`
- `demoUrl`
- `summary`
- `shortplayId`
- `shortplayName`
- `coverImageUrl`
- `episodeVideoUrls`
- `authorName`
- `productionProofFileUrl`
- `licenseProofFileUrl`

校验规则要点：

- `title` 最大 60 字符
- `summary` 最少 300 字
- `episodeVideoUrls` 如果非空，数量必须等于 `episodeCount`
- `productionProofFileUrl` 和 `licenseProofFileUrl` 是合同上传所需 PDF URL

## 8. 本地数据库

表结构在 `src/storage/pinduoduo-apply-records-schema.ts`：

```text
pinduoduo_apply_records
```

主键：

- `account_task_id`

关键字段：

- `audit_status`
- `video_status`
- `platform_apply_id`
- `platform_status`
- `platform_reject_reason`
- `payload_json`
- `next_check_at`
- `last_checked_at`
- `submitted_at`

审核状态：

```text
PENDING
APPROVED
REJECTED
UNKNOWN（审核检查异常状态；例如已提报列表 2000 条内找不到该任务。当前提报失败不写入 UNKNOWN 记录）
```

视频状态：

```text
NOT_READY
READY
RESOURCE_READY
UPLOADING
UPLOADED
```

目前没有 `UPLOADED` 的写入逻辑，属于后续上传完成后可接入的状态。

`video_status` 的用途：

- `video_status` 是本地数据库里的“审核通过后视频发布阶段”进度标记。
- 它不来自拼多多平台，也不是后端状态字段。
- 它存在于本地表 `pinduoduo_apply_records`，用于让服务判断下一轮该执行哪一步。
- `audit_status` 管审核阶段，`video_status` 管审核通过后的发布阶段。

当前每个值的含义：

- `NOT_READY`
  - 短剧刚提报成功，正在等待审核。
  - 还不能准备视频资源。
- `READY`
  - 审核已通过。
  - 下一步应该准备本地视频资源。
  - 触发条件：`audit_status` 变成 `APPROVED` 时，如果原来是 `NOT_READY`，自动改成 `READY`。
- `RESOURCE_READY`
  - 百度网盘资源已下载 / 整理到本地视频目录。
  - 下一步可以打开拼多多“内容管理”页面。
  - 触发条件：`ensureBaiduNetdiskResource()` 成功，并且后端 `VIDEO_RESOURCE_READY` 上报成功后更新。
- `UPLOADING`
  - 已经进入内容管理页面，准备进入视频上传阶段。
  - 当前代码只做到打开内容管理页，还没实现真正上传视频。
  - 触发条件：内容管理页打开成功，并且后端 `VIDEO_UPLOADING` 上报成功后更新。
- `UPLOADED`
  - 预留状态。
  - 当前没有代码写入。

## 9. 本地状态转换

### 9.1 提报成功

提报成功后会先上报后端，只有后端 success callback 成功后才写入本地数据库。

调用：

```ts
upsertSubmittedRecord(task, submittedRecord)
```

写入：

```text
audit_status = PENDING
video_status = NOT_READY
next_check_at = 当前时间 + taskPollIntervalMinutes，夜间顺延到 08:00
```

先上报后端：

```text
rpaStatus = AUDIT_PENDING
resultJson.auditStatus = PENDING
```

### 9.2 提报失败

提报失败不写入本地数据库，只记录日志并上报后端：

```text
failStage = SUBMIT_SHORTPLAY
```

### 9.3 审核仍在进行

条件：

- 平台接口 2000 条已提报记录中匹配到了本地任务。
- 平台 `record.status === 1`。

调用：

```ts
markAuditChecked(record, "PENDING", platformRecordOrNull)
```

写入：

```text
audit_status = PENDING
next_check_at = 当前时间 + taskPollIntervalMinutes，夜间顺延到 08:00
video_status 保持原值
```

上报：

```text
rpaStatus = AUDIT_PENDING
```

### 9.4 审核记录未匹配

条件：

- 本地任务已到 `next_check_at`。
- 已提报短剧接口按 `page_size=2000` 拉取后，仍然匹配不到该任务。

处理：

```text
audit_status = UNKNOWN
platform_reject_reason = 找不到该任务的失败原因
raw_json = 包含 CHECK_AUDIT、errorMessage、activeUrl、checkedSubmittedRecordCount 等备注上下文
next_check_at = null
failStage = CHECK_AUDIT
```

处理顺序：

1. 先把失败原因写入本地库，标记 `audit_status = UNKNOWN`。
2. 再上报后端该任务失败，`failStage = CHECK_AUDIT`。
3. 这类任务不再继续作为 `PENDING` 反复轮询。

### 9.5 审核拒绝

条件：

```ts
record.status === 3
```

调用：

```ts
markAuditChecked(record, "REJECTED", platformRecord)
```

写入：

```text
audit_status = REJECTED
next_check_at = null
platform_reject_reason = record.rejectReason
video_status 保持原值
```

然后上报：

```text
failStage = CHECK_AUDIT
```

注意：当前任务状态枚举里有 `AUDIT_REJECTED`，但代码没有 success callback 到 `AUDIT_REJECTED`，而是走 fail callback。

### 9.6 审核通过

条件：

```ts
record.status !== 1 && record.status !== 3
```

也就是说，当前代码把除 `1` 和 `3` 之外的状态都当作审核通过。

调用：

```ts
markAuditChecked(record, "APPROVED", platformRecord)
```

写入：

```text
audit_status = APPROVED
next_check_at = null
如果 video_status 是 NOT_READY，则改成 READY
```

上报：

```text
rpaStatus = VIDEO_UPLOAD_READY
resultJson.auditStatus = APPROVED
```

### 9.7 视频资源准备完成

条件：

```text
audit_status = APPROVED
video_status = READY
```

调用：

```ts
ensureBaiduNetdiskResource(...)
markVideoResourceReady(record)
```

写入：

```text
video_status = RESOURCE_READY
```

上报：

```text
rpaStatus = VIDEO_RESOURCE_READY
```

### 9.8 进入内容管理

条件：

```text
audit_status = APPROVED
video_status = RESOURCE_READY
```

调用：

```ts
runPinduoduoApprovedShortplayFlow(page, options, task)
markVideoUploading(record)
```

写入：

```text
video_status = UPLOADING
```

上报：

```text
rpaStatus = VIDEO_UPLOADING
resultJson.contentManagementUrl = 打开的内容管理页 URL
```

当前这一步只打开内容管理页，还没有上传视频和提交发布的后续逻辑。

## 10. 短剧提报流程

入口：

```ts
claimAndSubmitApplyTask()
```

执行步骤：

1. 领取一个 `READY` 任务。
2. 调用 `submitPinduoduoShortplayApplyEdit(page, task)`。
3. 刷新短剧管理页的“待提报短剧”列表。
4. 按标题选择刚提报的短剧行。
5. 上传制作合同和授权合同 PDF。
6. 勾选提报协议。
7. 点击“提报全部”。
8. 切到“已提报短剧”，查找刚提交的记录。
9. 上报 `AUDIT_PENDING`。
10. 后端 success callback 成功后，写入本地数据库用于后续审核轮询。

### 10.1 调用短剧提报接口

代码：

```ts
submitPinduoduoShortplayApplyEdit()
```

请求地址：

```text
https://mcn.pinduoduo.com/mms/gaia/topic/apply/edit
```

请求方式：

- 在浏览器页面内 `page.evaluate(fetch(...))`
- `credentials: "include"`，复用浏览器登录态
- `content-type: application/json`
- `referrer` 是短剧管理页

提交 body：

```ts
{
  topic_apply_edit_vos: [
    {
      content_type,
      sub_content_type,
      is_series_play,
      copyright,
      copyright_expire_time,
      title,
      director,
      producer,
      script_writer,
      role,
      episode_count,
      duration_minutes,
      duration_seconds,
      cate,
      label_ids,
      copyright_agency,
      cost,
      icp_number,
      salary_percent,
      major_salary_percent,
      online_time,
      demo_url,
      summary
    }
  ]
}
```

失败判断：

- HTTP 非 2xx
- `payload.code` 存在且不为 0
- `payload.success === false`

失败时抛 `PinduoduoShortplayApplyEditError`，错误里带平台响应。

### 10.2 刷新和选中待提报短剧

代码：

- `refreshShortplayManagePendingList()`
- `selectShortplayManageRowByTitle()`

页面：

```text
https://mcn.pinduoduo.com/home/shortplayManage
```

刷新方式：

1. 点击“已提报短剧”
2. 等待 `/mms/gaia/topic/apply/list`，`tab_type=1`
3. 点击“待提报短剧”
4. 等待 `/mms/gaia/topic/apply/list`，`tab_type=0`

选中方式：

- 找 `td[data-testid="beast-core-table-td"]`，文本精确匹配标题
- 找标题前一个单元格作为 checkbox 单元格
- 依次尝试：
  - `checkbox-checkIcon.click`
  - `checkbox-label.click`
  - `input.click`
  - `input.setChecked`
  - 点击 checkbox 单元格中心点

### 10.3 上传合同

代码：

```ts
uploadPinduoduoContractFiles()
```

需要两个 PDF URL：

- `task.playlet.productionProofFileUrl`
- `task.playlet.licenseProofFileUrl`

流程：

1. 下载两个 PDF 到 `<accountDir>/upload-assets/contracts`
2. 找上传 input：

```text
input[data-testid="beast-core-upload-input"][type="file"][accept=".pdf"]
```

3. `setInputFiles(filePaths)`
4. 等待上传预览里出现 PDF 链接和成功图标

如果合同 URL 不等于 2 个，直接失败。

### 10.4 提交审核

代码：

```ts
submitSelectedShortplaysForAudit()
```

流程：

1. 找“我已阅读并同意”协议 checkbox。
2. 如果未勾选则点击勾选。
3. 等“提报全部”按钮可用。
4. 点击“提报全部”。
5. 检查 toast：
   - warning toast
   - error toast
6. 如果 toast 有内容，抛错。

## 11. 审核检查流程

入口：

```ts
checkLocalAuditTask()
```

取数条件：

```sql
WHERE audit_status='PENDING'
  AND (next_check_at IS NULL OR next_check_at <= now)
ORDER BY COALESCE(next_check_at, submitted_at, created_at) ASC
```

该查询会返回所有到期审核记录。如果同一时间有 90 条到期，审核分支会在同一轮内尝试处理这 90 条，不再每轮只处理 1 条。

查平台记录：

```ts
fetchSubmittedShortplayApplyRecords(page, options, { page: 1, pageSize: 2000 })
```

平台查询方式：

1. 在已登录的拼多多页面内直接 `fetch`：

```text
POST https://mcn.pinduoduo.com/mms/gaia/topic/apply/list
```

2. 请求体：

```json
{
  "tab_type": 1,
  "page": 1,
  "page_size": 2000
}
```

3. `tab_type=1` 表示“已提报短剧”。
4. 使用 `credentials: "include"` 复用当前浏览器登录态。
5. 不硬编码抓包里的 `anti-content`，因为它通常是会话和风控相关的动态值。

批量匹配方式：

1. 从接口响应 `result.list` 读取最多 2000 条已提报记录。
2. 对本轮所有到期本地记录逐条匹配。
3. 优先按 `platformApplyId` 匹配，因为它唯一。
4. 没有 `platformApplyId` 或没匹配到时，再按 `title` 匹配。
5. 如果在这 2000 条里仍然没匹配到某个到期任务，则认为该任务审核检查失败：
   - 先在本地库标记 `audit_status = UNKNOWN`
   - 在 `platform_reject_reason` 和 `raw_json` 里记录找不到任务的失败原因和上下文
   - 调用后端 fail callback，`failStage = CHECK_AUDIT`
   - 不再继续作为 `PENDING` 反复轮询

平台记录字段只读取：

- `id`
- `title`
- `status`
- `reject_reason`

当前状态判断：

```text
record 不存在       -> CHECK_AUDIT 失败，本地 UNKNOWN
record.status === 1 -> PENDING
record.status === 3 -> REJECTED
其他 status         -> APPROVED
```

## 12. 审核通过后的内容管理流程

新增独立文件：

```text
src/app/approved-shortplay-flow.ts
```

入口：

```ts
runApprovedShortplayQueue(page, options, repository)
  -> prepareLocalVideoResourceTask(options, repository, record)
  -> runPinduoduoApprovedShortplayFlow(page, options, task)
```

当前只做到打开内容管理页，没有上传视频。

队列取数条件：

```sql
WHERE audit_status='APPROVED'
  AND video_status IN ('READY', 'RESOURCE_READY')
ORDER BY updated_at ASC
```

执行规则：

- `READY`：先准备本地视频资源，成功后更新为 `RESOURCE_READY`，随后同一轮继续打开内容管理。
- `RESOURCE_READY`：直接打开内容管理。
- 内容管理打开成功后，后端上报 `VIDEO_UPLOADING`，本地更新为 `video_status='UPLOADING'`。
- 单条准备资源或打开内容管理失败，只上报该条失败，不阻断队列里的下一条记录。

页面：

```text
https://mcn.pinduoduo.com/home/management
```

实测页面结构：

- 表格第一列包含：

```text
草莓漫剧
ID：1053168546
```

- 操作列包含：

```text
合作管理
内容管理
```

定位逻辑：

1. 打开签约主播 / 作者管理页。
2. 等待表格行：

```text
tr[data-testid="beast-core-table-body-tr"]
```

3. 第一列必须包含：
   - `pinduoduoAccountId`
   - `pinduoduoAccountName`
4. 最后一列必须包含“内容管理”。
5. 先用 Playwright locator 点击“内容管理”。
6. 如果 locator 点击失败，改用 DOM 内 `click()`。
7. 等待 popup 或当前页跳转到：

```text
https://mcn.pinduoduo.com/home/creator/manage?uid=...
```

8. 校验页面内容包含：
   - `主播：<pinduoduoAccountName>`
   - `ID：<pinduoduoAccountId>`

实测打开结果示例：

```text
https://mcn.pinduoduo.com/home/creator/manage?uid=7735796497358
```

## 13. 视频资源准备流程

入口：

```ts
prepareLocalVideoResourceTask()
```

取数条件：

```sql
WHERE audit_status='APPROVED'
  AND video_status='READY'
ORDER BY updated_at ASC
```

该查询现在作为上剧队列的一部分执行，不再只处理 1 条。多个已通过任务会按 `updated_at` 顺序串行准备资源。

执行：

```ts
ensurePinduoduoVideoResourceReady(options, task)
```

要求：

- `task.playlet.demoUrl` 必须有值，作为百度网盘分享文本。
- `options.config.video.localEpisodeVideoRoot` 必须配置。
- `options.ensureBaiduNetdiskResource` 必须存在。

实际下载动作由 Electron 注入：

```ts
ensureBaiduNetdiskShareDownloaded(request)
```

参数：

```ts
{
  shareText: task.playlet.demoUrl,
  resourceName: task.originalTitle,
  localEpisodeVideoRoot,
  episodeCount: task.playlet.episodeCount
}
```

重试：

- 默认重试 3 次
- 每次失败间隔 5 秒
- 最大尝试次数 = `retryAttempts + 1`

成功后：

```text
video_status = RESOURCE_READY
rpaStatus = VIDEO_RESOURCE_READY
```

## 14. 任务状态枚举和实际使用情况

包内任务状态枚举：

```text
READY
CLAIMED
RUNNING
AUDIT_PENDING
AUDIT_REJECTED
AUDIT_APPROVED
VIDEO_UPLOAD_READY
VIDEO_RESOURCE_READY
VIDEO_UPLOADING
SUCCESS
FAILED
```

当前实际上报：

- `AUDIT_PENDING`
- `VIDEO_UPLOAD_READY`
- `VIDEO_RESOURCE_READY`
- `VIDEO_UPLOADING`

当前未实际上报：

- `CLAIMED`
- `RUNNING`
- `AUDIT_REJECTED`
- `AUDIT_APPROVED`
- `SUCCESS`
- `FAILED`

失败时走 fail callback，带 `failStage`：

```text
SUBMIT_SHORTPLAY
CHECK_AUDIT
PREPARE_VIDEO_RESOURCE
UPLOAD_VIDEO
```

枚举里还有但当前拼多多主流程未使用：

```text
CLAIM_TASK
LOGIN
OPEN_SHORTPLAY_MANAGE
FILL_SHORTPLAY
UNKNOWN
```

## 15. 当前完整状态机

```text
后端 READY 任务
  |
  | claimAndSubmitApplyTask()
  v
本地 PENDING / NOT_READY
后端 AUDIT_PENDING
  |
  | checkLocalAuditTask(), 平台仍待审
  v
本地 PENDING / NOT_READY
后端 AUDIT_PENDING
  |
  | checkLocalAuditTask(), 平台拒绝
  v
本地 REJECTED / NOT_READY
后端 failCallback(CHECK_AUDIT)
  |
  | checkLocalAuditTask(), 平台通过
  v
本地 APPROVED / READY
后端 VIDEO_UPLOAD_READY
  |
  | prepareLocalVideoResourceTask()
  v
本地 APPROVED / RESOURCE_READY
后端 VIDEO_RESOURCE_READY
  |
  | runApprovedShortplayFlowTask()
  v
本地 APPROVED / UPLOADING
后端 VIDEO_UPLOADING
  |
  | 后续未实现：上传视频 / 发布 / 完成回调
  v
理论目标：UPLOADED 或 SUCCESS
```

## 16. 当前容易误解的点

### 16.1 启动服务不一定领取真实任务

如果没有传 `config.api`，包会使用 mock 任务。当前 Electron 拼多多配置页没有 API Base URL 字段，启动参数也没有传 `api`。

### 16.2 `video_status='READY'` 不是后端返回的

它是本地数据库状态，在审核通过时由：

```ts
markAuditChecked(..., "APPROVED", ...)
```

自动从 `NOT_READY` 改成 `READY`。

### 16.3 审核状态枚举已确认

2026-09-21 用真实账号实测 `/mms/gaia/topic/apply/list`（`tab_type=1` 已提报短剧）确认：

```text
status = 1 -> 已提报，待审核（页面显示“已提报，待审核”，reject_reason 为空）
status = 2 -> 审核通过（reject_reason 为空）
status = 3 -> 审核驳回（reject_reason 有值，如“备案号验证无效”）
```

该接口不支持服务端状态筛选：请求体里传 `status` / `audit_status` / `apply_status` 会被忽略，返回未筛选的全量列表。页面本身也没有状态筛选控件，只能靠本地按 `status` 过滤。

`fetchApprovedShortplays` 已改为按 `status === 2` 本地筛选，并按原始分页（每页 50 条）扫描，扫到 `total_count` 为止；`runApprovedShortplayCycle` 处理每页筛出的全部通过记录。

`task-runner.ts` 的审核结论仍把 `status !== 1 && status !== 3` 当作通过，与上述枚举一致（实测只出现 1/2/3），如未来出现新状态值需要再收紧。

### 16.4 内容管理流程已经接入，但只打开页面

当前已经会在：

```text
audit_status = APPROVED
video_status = RESOURCE_READY
```

时打开内容管理页，并把本地状态改成 `UPLOADING`。但没有真正上传视频，也没有发布，也没有完成回调。

### 16.5 审核检查优先级高

如果本地有到期的 `PENDING` 审核记录，主循环会先同步这些审核状态。

同步后不会直接结束本轮，而是继续组装并串行处理所有：

```text
audit_status = APPROVED
video_status = READY 或 RESOURCE_READY
```

的上剧候选记录。只有审核同步和上剧队列都没有可处理数据时，才会领取新的提报任务。

### 16.6 提报失败不落本地数据库

提报失败只会：

```text
1. 写运行日志
2. 调用后端 fail callback，failStage = SUBMIT_SHORTPLAY
```

不会创建或更新 `pinduoduo_apply_records` 记录。

## 17. 如何测试当前内容管理步骤

前置条件：

1. 拼多多服务已经登录。
2. 本地数据库存在一条记录：

```text
audit_status = APPROVED
video_status = RESOURCE_READY
pinduoduo_account_id = 真实作者 ID
pinduoduo_account_name = 真实作者名
```

3. 启动服务或等待主循环下一轮。

预期：

1. 浏览器打开：

```text
https://mcn.pinduoduo.com/home/management
```

2. 找到包含 `pinduoduo_account_id` 和 `pinduoduo_account_name` 的行。
3. 点击操作列“内容管理”。
4. 打开：

```text
https://mcn.pinduoduo.com/home/creator/manage?uid=...
```

5. 本地记录变成：

```text
video_status = UPLOADING
```

6. 后端如果已配置，会收到：

```text
rpaStatus = VIDEO_UPLOADING
```

如果记录是：

```text
audit_status = APPROVED
video_status = READY
```

服务会先执行百度网盘资源准备。准备成功后同一轮继续进入内容管理。

## 18. 后续建议

优先建议补齐：

1. 在拼多多配置中接入真实 `apiBaseUrl` / headers，并从 Electron 传入 `config.api`。
2. 明确拼多多审核状态枚举，避免把未知状态误判为通过。
3. 给 `UPLOADING` 后续补完整视频上传、发布和成功回调。
4. 给后端失败回调记录设计重试或人工处理入口。
5. 给本地数据库记录做一个 UI 列表，方便观察 `audit_status`、`video_status` 和错误原因。
6. 把内容管理页的后续上传逻辑继续放在 `approved-shortplay-flow.ts` 或其子模块中，保持审核通过后流程独立。

## 19. 审核通过短剧上传记录表和循环上传

新增独立表（与 `pinduoduo_apply_records` 同一个 `automation.sqlite`）：

```text
pinduoduo_approved_upload_records
```

建表 / 索引迁移在 `src/storage/pinduoduo-upload-records-schema.ts` 的 `migratePinduoduoUploadRecords()`，幂等执行。

主键：

- `platform_apply_id`（拼多多已提报记录 id）

关键字段：

- `status`
- `stage`
- `error_message`
- `attempts`
- `demo_url`
- `episode_count`
- `uploaded_at`
- `last_attempt_at`

状态机：

```text
PENDING -> DOWNLOADING -> READY -> UPLOADING -> UPLOADED
   任一阶段失败 -> FAILED（带 stage / error_message）
   FAILED 且 attempts < 3 时，下一轮可重试
   平台明确拒绝（页面出现“视频上传失败”）-> REJECTED（终态，不再重试，「重试失败」也不会重置）
```

`stage` 只在失败时写入，取值：

```text
DOWNLOAD   下载 / 本地视频检查失败
OPEN_PAGE  打开发布页失败（含未配置 creatorUid）
UPLOAD     setInputFiles 上传动作失败
VERIFY     等待上传完成超时或页面错误（REJECTED 的 stage 也记为 VERIFY）
BIND       逐集“添加至已有短剧”绑定失败
PUBLISH    点击发布或发布成功校验失败
```

`attempts` 只在进入 `DOWNLOADING`（一次尝试的起点）时加一，同时写入 `last_attempt_at` 并清空上一轮的 `stage` / `error_message`。

仓库类：`src/storage/pinduoduo-upload-records-repository.ts` 的 `PinduoduoUploadRecordsRepository`，方法：

```text
upsertFromApprovedList(records)
findProcessableRecords(maxAttempts = 3)
markDownloading(id) / markReady(id) / markUploading(id)
markUploaded(id)
markFailed(id, stage, errorMessage)
markRejected(id, errorMessage)
```

`upsertFromApprovedList` 对已有行只刷新 `title` / `episode_count` / `demo_url` / `raw_json` / `updated_at`，不会覆盖 `status` / `stage` / `error_message` / `attempts`，所以已 `UPLOADED` 的行不会被重新拉回待处理。

循环入口：`src/app/approved-shortplay-cycle.ts` 的 `runApprovedShortplayCycle(page, context, options)`，每轮分两阶段：

1. 同步阶段：用 `fetchApprovedShortplays` 按原始分页扫完列表，只保留“审核通过且尚未创建短剧”（`status === 2 && topic_create_status !== 1`）的记录，再 `upsertFromApprovedList` 落库，替代原来的内存 `seenIds` 去重。`topic_create_status === 1` 表示短剧已经创建，必须跳过，并按平台提报 ID 删除本地上传跟踪表中以前遗留的对应记录。
2. 执行阶段：取 `findProcessableRecords()`（`PENDING` 或可重试的 `FAILED`，按 `updated_at` 升序），逐条独立 try/catch 处理，单条失败不会中断队列：
   - 未配置 `config.creatorUid` 时直接 `markFailed(id, 'OPEN_PAGE', ...)` 并跳到下一条，不抛错。
   - `markDownloading` 后调用 `options.ensureBaiduNetdiskResource` 下载视频，成功 `markReady`；下载目录里没有 `.mp4/.wmv/.mov/.avi/.m4v` 文件时 `markFailed(id, 'DOWNLOAD', ...)`。
   - `markUploading` 后打开 `https://mcn.pinduoduo.com/home/creator/publish?uid=<creatorUid>`，`setInputFiles` 到视频专用 input（`input[data-testid="beast-core-upload-input"][accept*=".mp4"]`，页面上还有另一个同样 class 的图片 input，靠 `accept` 区分）。
   - 等第一张视频卡片出现后，逐集填写表单：视频描述填入文件名去掉扩展名（`剧名 - 第x集`），内容声明下拉选「含AI生成内容」。卡片按 `文件名：<fileName>` 的 `p` 元素向上定位到包含「添加至已有短剧」按钮的容器。
   - 用首张视频卡片点击「添加至已有短剧」，在无搜索框的剧目列表中滚动找到同名短剧并勾选，再勾选「将所上传视频全部添加至此短剧」并点击「确认添加」，一次绑定全部视频；绑定失败记 `BIND` 失败（可重试）。
   - 等待页面不再出现 /上传中|处理中/（配置 `videoUploadTimeoutMinutes`，默认 60 分钟）；超时或页面错误记 `VERIFY` 失败。
   - 上传完成后检查页面是否出现「视频上传失败」（如“视频分辨率不能低于1080P”）：出现则 `markRejected` 记 `REJECTED` 终态并带上平台原因，不再重试这部剧。
   - 全部上传成功后点击页面级「一键发布」（若弹出确认框则点确认），不再逐集寻找「发布」按钮。点击后校验“发布成功/已发布”、按钮隐藏或按钮禁用等成功信号，60 秒内无信号记 `PUBLISH` 失败（可重试）。
   - 最后一集发布完成后页面保留 10 秒再关闭，然后 `markUploaded`。
   - 上传页在 finally 中必定关闭。

调度：`src/app/runtime.ts` 里启动后立即跑一轮，之后按 `pinduoduoTaskPollIntervalMs(options)`（配置 `taskPollIntervalMinutes`，默认 120 分钟）循环执行。循环用可唤醒的 `setTimeout` 等待，串行不重叠；`stop()` 置 `running=false` 并唤醒等待后循环退出，单轮异常只记日志不会终止循环。
