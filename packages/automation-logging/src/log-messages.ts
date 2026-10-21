export type LogMessageRule = readonly [pattern: RegExp, replacement: string];

/**
 * Common legacy messages normalized at the logging boundary.
 *
 * Keep replacements short and action-oriented. Platform-specific facts belong in
 * structured context fields instead of being interpolated into the message.
 */
export const conciseLogMessageRules: ReadonlyArray<LogMessageRule> = [
  [/^运行时启动[：:].*$/u, "服务启动"],
  [/^运行时停止$/u, "服务停止"],
  [/^任务开始[：:].*$/u, "任务开始"],
  [/^获取到\s*\d+\s*条\s*READY\s*任务$/iu, "发现待处理任务"],
  [/^开始创建合集并批量上传[：:].*$/u, "创建合集并上传"],
  [/^批量发布页面已就绪$/u, "发布页面就绪"],
  [/^创建合集页面已就绪$/u, "合集页面就绪"],
  [/^已使用配置的本地浏览器启动$/u, "浏览器启动"],
  [/^(?:runtime )?started$/i, "服务启动"],
  [/^(?:runtime )?stopping$/i, "服务停止中"],
  [/^(?:runtime )?stopped$/i, "服务停止"],
  [/^application is quitting$/i, "应用退出"],
  [/^task started$/i, "任务开始"],
  [/^task succeeded$/i, "任务完成"],
  [/^task failed(?:, pipeline continues)?$/i, "任务失败"],
  [/^claiming task$/i, "领取任务"],
  [/^claimed (?:account )?task$/i, "任务已领取"],
  [/^no claimable (?:account )?task$/i, "暂无任务"],
  [/^account task page request$/i, "查询任务"],
  [/^account task page response$/i, "任务列表已返回"],
  [/^claim request$/i, "提交任务领取"],
  [/^claim response$/i, "任务领取已响应"],
  [/^success callback request$/i, "上报任务完成"],
  [/^success callback response$/i, "完成上报已响应"],
  [/^success callback completed$/i, "任务完成已上报"],
  [/^fail callback request$/i, "上报任务失败"],
  [/^fail callback response$/i, "失败上报已响应"],
  [/^fail callback completed$/i, "任务失败已上报"],
  [/^worker started$/i, "任务队列启动"],
  [/^worker stopped$/i, "任务队列停止"],
  [/^renderer console warning$/i, "界面警告"],
  [/^renderer console error$/i, "界面错误"],
  [/^renderer page load failed$/i, "界面加载失败"],
  [/^renderer preload failed$/i, "界面预加载失败"],
  [/^renderer process exited$/i, "界面进程退出"],
  [/^child process exited$/i, "子进程退出"],
  [/^uncaught main-process exception$/i, "主进程未捕获异常"],
  [/^unhandled main-process rejection$/i, "主进程未处理异常"],
];
