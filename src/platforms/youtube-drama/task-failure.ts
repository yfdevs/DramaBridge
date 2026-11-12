import type { YoutubeTask, YoutubeTaskFailure } from "./service";

export function youtubeTaskFailure(task: YoutubeTask): YoutubeTaskFailure | null {
  if (!task.error) return null;
  if (task.progress?.failure) return task.progress.failure;
  // Older workers retained the useful message only in logs. Surface the cause,
  // without restoring a raw-log panel or presenting unrelated earlier attempts.
  const generic = /程序退出.*代码|处理程序异常退出/.test(task.error);
  const attempt = (task.logs ?? "").split("开始 / 恢复任务").pop() ?? "";
  const source = generic ? attempt : task.error;
  if (/invalid_grant|token 已失效|授权缺失或已失效|授权已失效/.test(source)) {
    return {
      code: "AUTH_INVALID",
      title: "账号授权已失效",
      reason: "当前账号授权无法刷新，可能已过期或被撤销。",
      action: "到账号管理更新该账号的授权，测试通过后重试。",
      stage: "authorizing",
    };
  }
  return {
    code: "PROCESS_FAILED",
    title: generic ? "处理程序异常退出" : task.error,
    reason: generic ? "处理程序未正常完成，旧版记录没有保存明确的错误原因。" : "任务未能完成。",
    action: generic
      ? "更新服务后重试；若仍失败，请提供任务编号和错误详情。"
      : "检查错误原因并处理后重试。",
    stage: task.progress?.stage,
  };
}
