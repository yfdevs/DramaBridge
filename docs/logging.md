# 日志规范

DramaBridge 的日志按“平台 → 模块 → 上下文”组织。任何平台都不得修改全局
`console`，也不得把其他平台的输出写入自己的日志文件。

## 文件布局

每个平台只写入自己的 `runDataDir/logs`：

```text
logs/
  app-YYYY-MM-DD.log
  structured/
    app-YYYY-MM-DD.jsonl
```

- `.log` 是默认给运营人员查看的简短中文日志。
- `structured/*.jsonl` 保存同一批结构化事件，供故障分析和后续日志界面使用。
- 百度网盘属于独立基础服务，写入 `baidu-netdisk` 日志；调用方通过上下文字段关联，
  不把网盘内部进度伪装成某个发布平台的日志。

## 固定字段

每条结构化记录包含：`version`、`time`、`level`、`platform`、`scope`、
`message`，可选 `context` 和 `details`。敏感字段由共享 logger 统一脱敏。

级别只使用：

- `debug`：仅供排查的细节。
- `info`：正常且有用的进度。
- `warn`：已降级、跳过或会自动重试，任务仍可继续。
- `error`：当前操作失败，需要关注。

模块优先使用：`runtime`、`account`、`auth`、`browser`、`task`、`netdisk`、
`download`、`material`、`upload`、`form`、`submit`、`api`、`storage`。

## 文案规则

- 面向用户的 `message` 使用简短中文，先写结果或当前动作，例如“登录成功”、
  “暂无待处理任务”、“第 2/4 次下载失败，5 秒后重试”。
- 平台、模块、账号、任务、路径等信息放入结构化字段，不手写 `[qq-drama]`、
  `[upload]` 或大段 `key=value` 前缀。
- 一条日志只表达一件事；轮询无变化、逐元素操作等噪声使用 `debug` 或不记录。
- 错误日志说明失败的动作，原始异常放入 `details.error`。
