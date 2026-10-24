# 百度短剧自动化

百度短剧上剧平台的独立 Playwright 运行时。运行时使用独立 Chromium 登录态，并通过
`@dramabridge/media-assets` 校验、准备本地剧集与海报资源。

## 后端接口

运行时使用 `/dramaAiRpa/baidu` 下的真实接口：

- `POST /accountConfig/page`：加载所有启用账号。
- `POST /accountTask/page`：按账号查询 `READY` 任务。
- `POST /rpa/claim`：按任务 ID 领取任务。
- `POST /rpa/report`：回写成功或失败结果。

服务启动时为每个启用账号创建独立浏览器。浏览器登录态优先使用账号配置的
`rpaProfileKey` 隔离；未配置时使用 `accountId`。

启动服务和执行任务时，创建页若在 60 秒内未就绪，会刷新当前页面并重新等待 60 秒；仅刷新重试一次，仍未就绪则报 `BAIDU_DRAMA_CREATE_PAGE_NOT_READY`。

领取响应中的 `payloadJson.baiduPlaylet` 保存百度表单字段，通用信息从 `payloadJson`
读取。四份合同由 `payloadJson.baiduContractFiles` 提供：

- `CONTRACT`：制作合同。
- `AUTHORIZATION`：授权书。
- `COST_REPORT`：成本配置报告。
- `COMMITMENT`：承诺书。

所有远程文件会先下载到任务素材目录，再通过 Playwright `setInputFiles` 上传，不会操作
系统文件选择窗口。
