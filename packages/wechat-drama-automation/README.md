# WeChat Video Automation

微信视频号剧集上架流程自动化服务。

## 任务来源

页面当前看到的图片材料要求通常是 `jpg/jpeg/bmp/png`，单个文件不超过 10MB；其他材料支持 `pdf/jpg/jpeg/bmp/png`。剧目海报建议 `816*1086px`，推广海报建议 `762*318px`。

当前自动填写的剧目基础信息字段包括：剧目名称、剧目简介、推荐语、总集数、变现类型、试看集数、剧目类型、AI内容声明、AI制作证明、剧目海报、推广海报、提审身份、制作方名称、剧目制作证明材料、版权采买&播出授权证明材料、剧目资质、剧目制作成本、剧目制作成本证明文件和其他材料。任务配置来自领取接口返回的 `payloadJson`，不再读取项目 `data/` 目录。

## 任务配置字段

空数组表示不上传该类材料；非必填字符串为空或删除该字段时，脚本会跳过填写。

| JSON 字段 | 中文名称 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `browser.userDataDir` | 单账号浏览器登录态目录 | `.auth/weixin-video-channel` | 仅命令行单 profile 模式使用；服务模式固定使用 `.drama-runs/wechat-drama/auth/channels/<视频号ID>`。 |
| `browser.headless` | 是否无头运行 | `false` | `false` 会显示浏览器窗口，便于扫码登录。 |
| `browser.slowMo` | 操作延迟 | `20` | 单位毫秒。 |
| `browser.keepOpenOnError` | 出错后保持浏览器打开 | `true` | 方便排查失败页面。 |
| `browser.keepOpenAfterRun` | 任务结束后保持浏览器打开 | `false` | 调试时可改为 `true`。 |
| `dryRun` | 是否试运行 | `true` | 保留字段；当前流程进入第三步后会自动确认提审。 |
| `playlet.name` | 剧目名称 | 示例剧名 | 领取任务后会被外层 `originalTitle` 原样覆盖，不做清洗。 |
| `playlet.summary` | 剧目简介 | 示例简介 | 必填。 |
| `playlet.recommendation` | 推荐语 | 示例推荐语 | 非必填。 |
| `playlet.episodeCount` | 总集数 | `9` | 必填，提交后通常不可变更。 |
| `playlet.monetization` | 变现类型 | `IAA广告变现` | 可选 `IAA广告变现`、`IAP付费变现`。 |
| `playlet.previewEpisodeCount` | 试看集数 | `1` | 必填。 |
| `playlet.dramaType` | 剧目类型 | `数字真人` | 可选 `真人`、`数字真人`、`漫剧`。 |
| `playlet.aiContent` | AI内容声明 | `true` | `true` 表示打开声明开关。 |
| `playlet.aiProductionProofFiles` | AI制作证明 | 忽略 | 微信视频号不读取或校验接口中的该字段。开启 AI 内容声明时，程序从本地或百度网盘准备好的原始权属图片中随机选择一张上传。 |
| `playlet.posters.main` | 剧目海报 | 无 | 必填文件路径，支持远程 URL 或非 `assets/` 的本地绝对路径。 |
| `playlet.posters.promotion` | 推广海报 | 无 | 非必填文件路径，支持远程 URL 或非 `assets/` 的本地绝对路径。 |
| `playlet.submissionIdentity` | 提审身份 | `版权方/授权播出方` | 可选 `剧目制作方`、`版权方/授权播出方`。 |
| `playlet.producerName` | 制作方名称 | 示例公司名 | 必填。 |
| `playlet.copyright.productionProofFiles` | 合同材料 | 忽略 | 微信视频号不校验、下载或上传该字段；剧目制作证明材料只上传本地识别出的权属工程截图。 |
| `playlet.copyright.licenseProofFiles` | 版权采买&播出授权证明材料 | 示例文件数组 | 可上传多个文件；远程文件保存在名称以 `-contract` 结尾的临时素材目录中。桌面端使用 `node-cron` 按 `Asia/Shanghai` 时区每天凌晨 1 点删除最后修改时间早于当天 00:00 的临时目录。 |
| `playlet.qualification.type` | 剧目资质 | `其他微短剧` | 可选 `重点/普通微短剧`、`其他微短剧`。 |
| `playlet.qualification.proofFiles` | 剧目资质证明材料 | 示例文件数组 | 可上传多个文件。 |
| `playlet.qualification.licenseOrRecordNumber` | 发行许可证号或备案号 | 无 | 仅页面需要时填写；非必填。 |
| `playlet.productionCost.amountWan` | 剧目制作成本 | `30` | 单位：万元。 |
| `playlet.productionCost.proofFiles` | 剧目制作成本证明文件 | 示例文件数组 | 对应页面里的选择文件上传。 |
| `playlet.otherMaterials` | 其他材料 | `[]` | 可上传多个文件。 |
剧集视频不从任务数据的 `episodes` 字段读取。设置 `localEpisodeVideoRoot` 后，程序使用领取接口返回的 `originalTitle`，扫描 `根目录/originalTitle` 以及 `根目录/originalTitle/成片`、`根目录/originalTitle/成品`、`根目录/originalTitle/视频`、`根目录/originalTitle/正片` 下的 `.mp4` 或 `.mov` 文件（后缀不区分大小写）。源文件名支持 `originalTitle-第N集.<后缀>`、`originalTitle - 第N集.<后缀>`、`originalTitle 第N集.<后缀>`、`originalTitleNN.<后缀>`、`originalTitle NN.<后缀>`、`originalTitle-NN.<后缀>`、`originalTitle - NN.<后缀>` 和 `N.<后缀>`；`-` 前后空格可有可无，不再支持下划线分隔。上传前会在运行数据目录创建硬链接，把上传文件名设为 `payloadJson.name-第N集.<原后缀>`；源视频和 `runDataDir` 需在同一磁盘分区。集数必须从 1 连续到 `playlet.episodeCount`，否则当前任务直接报错退出。

微信会递归扫描 `根目录/originalTitle` 下名称包含“权属”或“工程”的目录，收集目录及其子目录中的 `png/jpg/jpeg/bmp/webp` 图片；能够读取出宽高且高度大于宽度的竖图会被排除，不作为权属文件。图片按内容去重后由云 AI 识别工程类型，默认选择 4 张剪映工程截图和 4 张剧创/即梦工程截图，逐张原图上传到“剧目制作证明材料”，不拼接且不上传合同。两类图片分别不足配置数量时任务失败；数量可在微信平台配置页调整。任务包含百度网盘链接时，程序会将视频目录和完整权属目录分别下载，等待权属目录下载完成后再整理到本地标准目录。

微信的剧目海报和推广海报不使用后端返回的 `playlet.posters` 文件地址，且只匹配一张图片。程序会递归扫描本地剧目目录或百度网盘资源：首先在整个资源中匹配文件名包含“封面”或“海报”的 `png/jpg/jpeg/bmp/webp` 图片；完全没有文件名匹配时，才查找名称包含“封面”或“海报”的目录，并按文件名顺序选取第一张高度大于宽度的图片。网盘素材会随所在目录下载，完成后只复制一张到 `根目录/originalTitle/海报封面`，命名为 `originalTitle - 海报.扩展名`。剧目海报和推广海报固定复用该图片。
| `publish.submit` | 是否确认提审 | `false` | 保留字段；当前流程进入第三步后会自动确认提审。 |

## 多视频号配置

服务启动时会调用 `POST /dramaAiRpa/videoAccountConfig/page` 获取状态为 `ON` 的视频号列表，并为列表里的每个视频号启动一个独立 worker。服务运行中会按 `videoAccountSyncIntervalSeconds` 定时重新拉取视频号列表：新增视频号会自动启动 worker，已下线的视频号会停止继续领取新任务，名称变化会同步到内存状态。请求分页参数为 `page=1`、`pageSize=100`。

运行时配置由 Electron 主进程从 `electron-store` 读取后注入，用户通过配置页面修改；自动化包不读取环境文件或业务 `process.env`。

每个视频号 ID 对应一个独立账号目录，例如 `.drama-runs/wechat-drama/auth/channels/video-account-1001`。真正的浏览器 profile 保存在 `.drama-runs/wechat-drama/auth/channels/video-account-1001/chromium-profile`，该目录包含该账号独有的 cookie、Local Storage、IndexedDB 和浏览器缓存，账号之间不会读取或复制这些数据。各账号的 `storage-state.json` 只是调试快照，分别保存在自己的账号目录中。

不同视频号可以并行执行任务；同一个视频号由一个独立 worker 串行处理：按视频号 ID 领取任务，领到后立即执行，执行完成后再领取下一单。

## 启动运行时

运行时由桌面端服务控制页面启动。启动后会为视频号列表中的每个账号打开一个独立的浏览器窗口，自动进入视频号剧集后台。

服务会为每个视频号启动一个独立 worker。worker 会按视频号 ID 领取任务，领到后立即执行，执行完成后再领取下一单；任务失败时会调用 `/dramaAiRpa/rpa/failCallback` 上报失败，再继续领取下一单；没有领到任务时会短暂等待。领取任务前会先调用 `/dramaAiRpa/accountTask/page` 查询 `rpaStatus=READY` 的任务，再用任务 ID 调用 `/dramaAiRpa/rpa/claim`。

`/dramaAiRpa/accountTask/page` 请求体：

```json
{
  "page": 1,
  "pageSize": 100,
  "videoAccountId": "video-account-1001",
  "rpaStatus": "READY"
}
```

`/dramaAiRpa/rpa/claim` 请求体：

```json
{
  "accountTaskId": 35
}
```

`/dramaAiRpa/rpa/failCallback` 请求体：

```json
{
  "accountTaskId": 35,
  "failStage": "LOGIN/FILL_FORM/UPLOAD_FILE/SUBMIT/RECOGNIZE_RESULT/OTHER",
  "resultJson": {},
  "errorMessage": "string"
}
```

## 调试开关

任务配置里的 `browser` 支持：

```json
{
  "slowMo": 20,
  "keepOpenOnError": true,
  "keepOpenAfterRun": false
}
```

- `slowMo`：每个动作之间的放慢时间，越大越慢。
- `keepOpenOnError`：出错时不关闭浏览器，命令行按回车后才关闭。
- `keepOpenAfterRun`：无论成功或失败都停住浏览器，适合调试。

- `closeFailedTaskPages=true`：下一次任务开启新标签时关闭之前的任务标签。
- `closeFailedTaskPages=false`：保留所有任务标签，不区分任务成功或失败。
- `runDataDir=.drama-runs/wechat-drama`：微信视频号运行数据目录，用于临时上传文件、远程素材缓存、上传报告、账号登录态和日志；需与本地剧集视频目录在同一磁盘分区。日志以逐行 JSON 写入 `runDataDir/logs`，无视频号上下文的服务日志写入 `app-YYYY-MM-DD.json`；任务、领取、上传和保活刷新等带视频号上下文的日志按账号写入 `app-<视频号ID>-YYYY-MM-DD.json`。
- `logRetentionDays=3`：日志保留天数，默认保留最近 3 天。
- `workerEmptyClaimDelaySeconds=5`：没有领到任务时的短轮询间隔，默认 5 秒。
- `workerSlowEmptyClaimThreshold=10`：连续空任务达到该次数后切到慢轮询，默认 10 次；也就是默认第 1-9 次空任务后等 5 秒，第 10 次开始等 30 秒。
- `workerSlowEmptyClaimDelaySeconds=30`：慢轮询间隔，默认 30 秒。
- `videoAccountSyncIntervalSeconds=60`：运行中同步后端视频号列表的间隔，默认 60 秒；设为 0 可关闭定时同步。
- `idlePageRefreshIntervalSeconds=1500`：空闲账号用临时页访问后台以触发页面令牌续期的间隔，默认 1500 秒；设为 0 可关闭。
- `idlePageRefreshTimeoutSeconds=60`：单次临时页保活刷新超时，默认 60 秒。
- `idlePageRefreshJitterSeconds=300`：各账号保活刷新随机错峰秒数，默认 300 秒。
- `basicInfoStepTimeoutSeconds=600`：基础信息填写步骤总超时，默认 600 秒。
- `remoteFileDownloadTimeoutSeconds=120`：远程素材单文件下载超时，默认 120 秒。
- `episodeUploadWaitTimeoutSeconds=14400`：剧集文件上传最长等待时间，默认 14400 秒。
- `episodeUploadFailedRetryAttempts=3`：单个剧集文件提示“未能上传”后的最大重试次数，默认 3 次。
- `materialPreparationConcurrency=3`：全局并行准备网盘资源、权属、海报和 AI 材料的任务数。
- `taskPrefetchPerAccount=2`：每个视频号最多提前领取并准备的任务数；同一视频号仍按领取顺序串行发布。
- `videoTranscodeConcurrency=2`：全局同时运行的 FFmpeg 转码进程数。
- `videoTranscodeThreadsPerJob=2`：每个 FFmpeg 转码进程使用的线程数。
- `episodeVideoMaxFileMegabytes=490`：单集视频体积上限，按十进制 MB 计算；百度下载扫描确认文件稳定后，超过上限的视频会提前进入转码队列。
- `episodeVideoTargetFileMegabytes=480`：自动转码目标体积，必须小于上限以预留 MP4 容器开销。
- `feishuBotWebhookUrl=`：飞书自定义机器人 webhook。配置后会推送需要登录的视频号、任务成功、任务失败消息。

如果日志出现 `[skip] file not found`，说明任务配置里的本地文件路径不存在，该材料不会上传。项目内 `assets/...` 路径会被直接跳过；材料建议使用远程 URL。

## 提交保护

模板默认：

```json
{
  "dryRun": true,
  "publish": {
    "submit": false
  }
}
```

脚本进入提审确认页后会等待 3 秒，然后自动点击最终的“确认提审”。
