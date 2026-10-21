# Automation logging

所有桌面端和平台自动化日志统一写入各自运行目录下的 `logs/app-YYYY-MM-DD.json`。
文件采用逐行 JSON：每一行都是一个完整、可独立解析的日志事件，因此写入中断不会破坏此前记录。

基础字段：

- `time`、`level`、`platform`、`scope`、`message`：供人查看和通用筛选。
- `context`：账号、任务等贯穿子日志的上下文。
- `details`：当前事件的数量、路径、耗时等数据。
- `error`：错误事件的稳定结构，包含 `code`、完整 `codes` 链、`stage` 和可读的 `summary`。

文案保持简短，变量信息放入结构化字段。通用旧文案到新文案的映射集中维护在
`src/log-messages.ts`，不得在写入器中继续增加零散映射。

示例：

```json
{"version":1,"time":"2026-10-21 10:30:00.000","level":"error","platform":"douyin-drama","scope":"upload","message":"任务失败","context":{"accountTaskId":104},"error":{"code":"DOUYIN_DRAMA_EPISODE_VIDEO_INVALID","codes":["DOUYIN_DRAMA_EPISODE_VIDEO_INVALID"],"summary":"第 40 集视频校验失败，无法读取视频时长","stage":"UPLOAD"}}
```
